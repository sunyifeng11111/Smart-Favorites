import { describe, expect, it } from 'vitest';

import { SmartSaveService } from './smart-save-service';
import type {
  BookmarkNode,
  BookmarkPort,
  CapturedPage,
  JevClassificationRequest,
  JevClassificationResult,
  JevPort,
  OperationState,
  PagePort,
  Settings,
  SmartSaveStoragePort,
  StoredFolderExample,
} from './types';

class FakeBookmarks implements BookmarkPort {
  constructor(private readonly tree: BookmarkNode[]) {}

  async getTree(): Promise<BookmarkNode[]> {
    return structuredClone(this.tree);
  }

  async create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode> {
    const parent = findNode(this.tree, input.parentId);
    if (!parent) throw new Error(`Missing parent ${input.parentId}`);
    const bookmark: BookmarkNode = { id: 'created-1', ...input };
    parent.children ??= [];
    parent.children.push(bookmark);
    return structuredClone(bookmark);
  }

  async move(id: string, destination: { parentId: string; index?: number }): Promise<BookmarkNode> {
    const bookmark = removeNode(this.tree, id);
    const parent = findNode(this.tree, destination.parentId);
    if (!bookmark || !parent) throw new Error('Cannot move bookmark');
    bookmark.parentId = destination.parentId;
    parent.children ??= [];
    parent.children.splice(destination.index ?? parent.children.length, 0, bookmark);
    return structuredClone(bookmark);
  }

  async remove(id: string): Promise<void> {
    if (!removeNode(this.tree, id)) throw new Error('Cannot remove bookmark');
  }

  snapshot(): BookmarkNode[] {
    return structuredClone(this.tree);
  }
}

class FakeStorage implements SmartSaveStoragePort {
  private readonly operations = new Map<string, OperationState>();
  private readonly operationQueues = new Map<string, Promise<void>>();

  constructor(private settings: Settings) {}

  async getSettings(): Promise<Settings> {
    return structuredClone(this.settings);
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.settings = structuredClone(settings);
  }

  async getOperation(id: string): Promise<OperationState | undefined> {
    return structuredClone(this.operations.get(id));
  }

  async saveOperation(operation: OperationState): Promise<void> {
    this.operations.set(operation.id, structuredClone(operation));
  }

  async getFolderExamples(): Promise<StoredFolderExample[]> {
    return [];
  }

  async saveFolderExample(): Promise<void> {}

  async runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    this.operationQueues.set(id, result.then(() => undefined, () => undefined));
    return result;
  }
}

const page: CapturedPage = {
  title: 'WXT 测试指南',
  url: 'https://wxt.dev/guide/essentials/unit-testing',
  domain: 'wxt.dev',
  description: 'How to test a WXT extension',
  h1: 'Unit Testing',
  visibleText: 'Use Vitest to test extension behavior.',
  classificationAllowed: true,
};

describe('SmartSaveService', () => {
  it('automatically saves when JEV confidently selects an Eligible Folder', async () => {
    const bookmarks = new FakeBookmarks([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            parentId: '0',
            title: '书签栏',
            children: [
              { id: '10', parentId: '1', title: '开发', children: [] },
              {
                id: '11',
                parentId: '1',
                title: '设计',
                children: [
                  {
                    id: 'existing-1',
                    parentId: '11',
                    title: 'Design reference',
                    url: 'https://design.example/reference',
                    dateAdded: 100,
                  },
                  {
                    id: 'restricted-existing',
                    parentId: '11',
                    title: 'Sensitive local file',
                    url: 'file:///Users/example/private.html',
                    dateAdded: 200,
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const pagePort: PagePort = { inspect: async () => page, capture: async () => page };
    const requests: JevClassificationRequest[] = [];
    const jev: JevPort = {
      async classify(request): Promise<JevClassificationResult> {
        requests.push(request);
        return {
          choice: '10',
          confidence: 0.8,
          probabilities: { '10': 0.7, '11': 0.2, __no_match__: 0.1 },
        };
      },
      testKey: async () => undefined,
    };
    const storage = new FakeStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    const service = new SmartSaveService({
      pages: pagePort,
      bookmarks,
      jev,
      storage,
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-1' },
    });

    const result = await service.start({ tabId: 42 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.criteria).toEqual({
      '1': { path: '书签栏', examples: [] },
      '10': { path: '书签栏 / 开发', examples: [] },
      '11': {
        path: '书签栏 / 设计',
        examples: [{ title: 'Design reference', domain: 'design.example' }],
      },
      __no_match__: 'No existing folder is suitable',
    });
    expect(result).toMatchObject({
      id: 'operation-1',
      status: 'saved',
      saveMethod: 'automatic',
    });
    expect(findNode(bookmarks.snapshot(), '10')?.children).toEqual([
      expect.objectContaining({ title: page.title, url: page.url, parentId: '10' }),
    ]);

    const saved = await service.confirm({ operationId: result.id, folderId: '10' });
    expect(saved).toMatchObject({
      status: 'saved',
      finalFolderId: '10',
      finalFolderPath: '书签栏 / 开发',
    });
    expect(findNode(bookmarks.snapshot(), '10')?.children).toEqual([
      expect.objectContaining({
        title: page.title,
        url: page.url,
        parentId: '10',
      }),
    ]);
    expect(findNode(bookmarks.snapshot(), '11')?.children).toHaveLength(2);
  });

  it('shows three ordered Folder Candidates and confirms one destination idempotently', async () => {
    const bookmarks = new FakeBookmarks([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            parentId: '0',
            title: '书签栏',
            children: [
              { id: '10', parentId: '1', title: '开发', children: [] },
              { id: '11', parentId: '1', title: '设计', children: [] },
              { id: '12', parentId: '1', title: '产品', children: [] },
              { id: '13', parentId: '1', title: '阅读', children: [] },
            ],
          },
        ],
      },
    ]);
    const storage = new FakeStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => ({
          choice: '12',
          confidence: 0.79,
          probabilities: {
            '1': 0.01,
            '10': 0.2,
            '11': 0.25,
            '12': 0.4,
            '13': 0.1,
            __no_match__: 0.04,
          },
        }),
        testKey: async () => undefined,
      },
      storage,
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-2' },
    });

    const candidates = await service.start({ tabId: 42 });
    expect(candidates.status).toBe('candidates');
    expect(candidates.candidates.map(({ id }) => id)).toEqual(['12', '11', '10']);
    expect(candidates.folders.map(({ id }) => id)).toEqual(['1', '10', '11', '12', '13']);
    expect(findNode(bookmarks.snapshot(), '12')?.children).toEqual([]);

    const [saved, repeated] = await Promise.all([
      service.confirm({ operationId: candidates.id, folderId: '11' }),
      service.confirm({ operationId: candidates.id, folderId: '11' }),
    ]);

    expect(saved).toMatchObject({
      status: 'saved',
      finalFolderId: '11',
      finalFolderPath: '书签栏 / 设计',
    });
    expect(repeated).toEqual(saved);
    expect(findNode(bookmarks.snapshot(), '11')?.children).toHaveLength(1);
  });

  it('requires first-use consent and keeps manual Smart Save available after decline', async () => {
    const bookmarks = new FakeBookmarks([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '2',
            parentId: '0',
            title: '其他书签',
            children: [{ id: '20', parentId: '2', title: '稍后阅读', children: [] }],
          },
        ],
      },
    ]);
    const storage = new FakeStorage({
      consent: 'unknown',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let jevCalls = 0;
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => {
          jevCalls += 1;
          throw new Error('must not be called');
        },
        testKey: async () => undefined,
      },
      storage,
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-3' },
    });

    const disclosure = await service.start({ tabId: 42 });
    expect(disclosure.status).toBe('consent-required');
    expect(jevCalls).toBe(0);

    const manual = await service.decideConsent({ operationId: disclosure.id, granted: false });
    expect(manual.status).toBe('manual-selection');
    expect((await storage.getSettings()).consent).toBe('declined');

    const saved = await service.confirm({ operationId: disclosure.id, folderId: '20' });
    expect(saved).toMatchObject({ status: 'saved', finalFolderPath: '其他书签 / 稍后阅读' });
    expect(jevCalls).toBe(0);
  });

  it('falls back to the complete manual picker when intelligent classification fails', async () => {
    const bookmarks = new FakeBookmarks([
      {
        id: '0',
        title: '',
        children: [{ id: '1', parentId: '0', title: '书签栏', children: [] }],
      },
    ]);
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => {
          throw new Error('request failed with jev-secret');
        },
        testKey: async () => undefined,
      },
      storage: new FakeStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-4' },
    });

    const result = await service.start({ tabId: 42 });

    expect(result).toMatchObject({
      status: 'manual-selection',
      messageKey: 'classificationUnavailable',
    });
    expect(result.folders.map(({ id }) => id)).toEqual(['1']);
    expect(findNode(bookmarks.snapshot(), '1')?.children).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('jev-secret');
  });

  it('never calls JEV for a non-web page and still exposes every Eligible Folder', async () => {
    let jevCalls = 0;
    const bookmarks = new FakeBookmarks([
      {
        id: '0',
        title: '',
        children: [{ id: '1', parentId: '0', title: '书签栏', children: [] }],
      },
    ]);
    const service = new SmartSaveService({
      pages: {
        inspect: async () => ({
          ...page,
          url: 'chrome://settings/',
          domain: '',
          visibleText: '',
          classificationAllowed: false,
          restrictionReason: 'unsupported-scheme',
        }),
        capture: async () => ({
          ...page,
          url: 'chrome://settings/',
          domain: '',
          visibleText: '',
          classificationAllowed: false,
          restrictionReason: 'unsupported-scheme',
        }),
      },
      bookmarks,
      jev: {
        classify: async () => {
          jevCalls += 1;
          throw new Error('must not be called');
        },
        testKey: async () => undefined,
      },
      storage: new FakeStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-5' },
    });

    const result = await service.start({ tabId: 42 });

    expect(result.status).toBe('manual-selection');
    expect(result.folders.map(({ id }) => id)).toEqual(['1']);
    expect(jevCalls).toBe(0);
  });
});

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function removeNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  const index = nodes.findIndex((node) => node.id === id);
  if (index >= 0) return nodes.splice(index, 1)[0];
  for (const node of nodes) {
    const found = removeNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}
