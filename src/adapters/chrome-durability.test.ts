import { beforeEach, describe, expect, it, vi } from 'vitest';

const chrome = vi.hoisted(() => {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  return {
    local,
    session,
    createBookmark: vi.fn(),
    browser: {
      bookmarks: {
        create: vi.fn((input: { parentId?: string; title: string; url?: string }) => {
          return Promise.resolve({
            id: 'created-node',
            parentId: input.parentId ?? '420',
            ...input,
          });
        }),
        update: vi.fn((id: string, input: { title: string }) => {
          return Promise.resolve({ id, parentId: '2', ...input });
        }),
        getTree: vi.fn(async () => []),
        move: vi.fn(),
        remove: vi.fn(),
      },
      storage: {
        local: storageArea(local),
        session: storageArea(session),
      },
    },
  };
});

vi.mock('wxt/browser', () => ({ browser: chrome.browser }));

import { ChromeBookmarkPort } from './chrome-bookmarks';
import { ChromeStoragePort } from './chrome-storage';
import type { OperationState } from '../application/types';

describe('Chrome durability adapters', () => {
  beforeEach(() => {
    for (const key of Object.keys(chrome.local)) delete chrome.local[key];
    for (const key of Object.keys(chrome.session)) delete chrome.session[key];
    vi.clearAllMocks();
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, task: () => Promise<T>) => task(),
      },
    });
  });

  it('persists the managed Pending Folder id with settings', async () => {
    chrome.local.smartSaveSettings = {
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: ['10'],
      pendingFolderId: 'pending-42',
    };
    const storage = new ChromeStoragePort();

    const settings = await storage.getSettings();
    await storage.saveSettings(settings);

    expect(settings).toEqual({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: ['10'],
      pendingFolderId: 'pending-42',
    });
    expect(chrome.local.smartSaveSettings).toEqual(settings);
  });

  it('keeps captured in-flight operations in session storage for worker recovery', async () => {
    const storage = new ChromeStoragePort();
    const operation = capturedOperation();

    await storage.saveOperation(operation);

    await expect(storage.getActiveOperation(42, operation.page.url)).resolves.toEqual(operation);
    await expect(storage.getInFlightOperations()).resolves.toEqual([operation]);
  });

  it('projects completed operation transitions into local Recent Records', async () => {
    const storage = new ChromeStoragePort(() => '2026-09-22T08:00:00.000Z');
    const saving = {
      ...capturedOperation(),
      status: 'creating-bookmark' as const,
    };
    const saved: OperationState = {
      ...saving,
      status: 'saved',
      finalBookmarkId: 'bookmark-1',
      finalFolderId: 'folder-1',
      finalFolderPath: '书签栏 / 开发',
      saveMethod: 'automatic',
      mutation: {
        kind: 'created',
        bookmarkId: 'bookmark-1',
        title: saving.page.title,
        url: saving.page.url,
        currentParentId: 'folder-1',
      },
    };

    await storage.saveOperation(saving);
    await storage.saveOperation(saved);

    await expect(storage.getRecentRecords()).resolves.toEqual([
      expect.objectContaining({
        id: saved.id,
        operationId: saved.id,
        title: saved.page.title,
        url: saved.page.url,
        finalFolder: { id: 'folder-1', path: '书签栏 / 开发' },
        undoState: 'available',
        classificationPath: [expect.objectContaining({ kind: 'automatic-save' })],
      }),
    ]);
    expect(JSON.stringify(chrome.local.smartSaveRecentRecords)).not.toContain('visibleText');
  });

  it('deletes one Recent Record and clears all records in local storage', async () => {
    const storage = new ChromeStoragePort(() => '2026-09-22T08:00:00.000Z');
    chrome.local.smartSaveRecentRecords = [
      storedRecord('operation-1'),
      storedRecord('operation-2'),
    ];

    await storage.deleteRecentRecord('operation-1');
    await expect(storage.getRecentRecords()).resolves.toEqual([
      expect.objectContaining({ id: 'operation-2' }),
    ]);

    await storage.clearRecentRecords();
    await expect(storage.getRecentRecords()).resolves.toEqual([]);
  });

  it("creates the Pending Folder in the browser's profile-specific Other Bookmarks root", async () => {
    const bookmarks = new ChromeBookmarkPort();

    const folder = await bookmarks.createFolderInOtherBookmarks('待分类');

    expect(folder).toEqual({
      id: 'created-node',
      parentId: '420',
      title: '待分类',
    });
  });
});

function storageArea(state: Record<string, unknown>) {
  return {
    get: vi.fn(async (requested: string | string[]) => {
      const keys = Array.isArray(requested) ? requested : [requested];
      return Object.fromEntries(keys.map((key) => [key, state[key]]));
    }),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(state, structuredClone(values));
    }),
  };
}

function capturedOperation(): OperationState {
  return {
    id: 'operation-persisted',
    tabId: 42,
    status: 'classifying',
    page: {
      title: 'Captured page',
      url: 'https://example.com/captured',
      domain: 'example.com',
      description: '',
      h1: '',
      visibleText: '',
      classificationAllowed: true,
    },
    folders: [],
    candidates: [],
    duplicateBookmarks: [],
    createdAt: '2026-09-22T08:00:00.000Z',
    captureCompleted: true,
  };
}

function storedRecord(id: string) {
  return {
    id,
    operationId: id,
    title: id,
    url: `https://example.com/${id}`,
    timestamp: '2026-09-22T07:00:00.000Z',
    updatedAt: '2026-09-22T07:00:00.000Z',
    classificationPath: [
      { kind: 'confirmed-save', timestamp: '2026-09-22T07:00:00.000Z' },
    ],
    finalFolder: { id: 'folder-1', path: '书签栏 / 开发' },
    undoState: 'available',
  };
}
