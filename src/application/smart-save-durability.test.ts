import { describe, expect, it, vi } from 'vitest';

import { HttpJevClient, JevClientError } from '../adapters/jev-client';
import { SmartSaveService } from './smart-save-service';
import type {
  BookmarkNode,
  BookmarkPort,
  CapturedPage,
  JevPort,
  OperationState,
  PagePort,
  Settings,
  SmartSaveStoragePort,
  StoredFolderExample,
} from './types';

class DurableBookmarks implements BookmarkPort {
  private nextNodeId = 100;

  constructor(private readonly tree: BookmarkNode[]) {}

  async getTree(): Promise<BookmarkNode[]> {
    return structuredClone(this.tree);
  }

  async create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode> {
    return this.append({ id: String(this.nextNodeId++), ...input });
  }

  async createFolderInOtherBookmarks(title: string): Promise<BookmarkNode> {
    return this.append({
      id: String(this.nextNodeId++),
      parentId: '2',
      title,
      children: [],
    });
  }

  async updateTitle(id: string, title: string): Promise<BookmarkNode> {
    const node = findNode(this.tree, id);
    if (!node) throw new Error(`Missing node ${id}`);
    node.title = title;
    return structuredClone(node);
  }

  async move(id: string, destination: { parentId: string; index?: number }): Promise<BookmarkNode> {
    const node = detachNode(this.tree, id);
    const parent = findNode(this.tree, destination.parentId);
    if (!node || !parent) throw new Error('Cannot move bookmark');
    node.parentId = destination.parentId;
    parent.children ??= [];
    parent.children.splice(destination.index ?? parent.children.length, 0, node);
    return structuredClone(node);
  }

  async remove(id: string): Promise<void> {
    if (!detachNode(this.tree, id)) throw new Error(`Missing node ${id}`);
  }

  snapshot(): BookmarkNode[] {
    return structuredClone(this.tree);
  }

  private append(node: BookmarkNode): BookmarkNode {
    const parent = findNode(this.tree, node.parentId ?? '');
    if (!parent) throw new Error(`Missing parent ${node.parentId}`);
    parent.children ??= [];
    parent.children.push(node);
    return structuredClone(node);
  }
}

class DurableStorage implements SmartSaveStoragePort {
  private readonly operations = new Map<string, OperationState>();
  private readonly queues = new Map<string, Promise<void>>();

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

  async getActiveOperation(tabId: number, url: string): Promise<OperationState | undefined> {
    return structuredClone(
      [...this.operations.values()].find(
        (operation) =>
          operation.tabId === tabId &&
          operation.page.url === url &&
          operation.status !== 'saved' &&
          operation.status !== 'undone' &&
          operation.status !== 'duplicate-preserved' &&
          operation.status !== 'disabled' &&
          operation.status !== 'capture-failed',
      ),
    );
  }

  async getInFlightOperations(): Promise<OperationState[]> {
    return structuredClone(
      [...this.operations.values()].filter(
        ({ status }) =>
          status === 'classifying' ||
          status === 'saving-pending' ||
          status === 'creating-bookmark' ||
          status === 'moving-pending',
      ),
    );
  }

  async saveOperation(operation: OperationState): Promise<void> {
    this.operations.set(operation.id, structuredClone(operation));
  }

  async getFolderExamples(): Promise<StoredFolderExample[]> {
    return [];
  }

  async saveFolderExample(): Promise<void> {}

  async runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    this.queues.set(id, result.then(() => undefined, () => undefined));
    return result;
  }

  settingsSnapshot(): Settings {
    return structuredClone(this.settings);
  }

  operationCount(): number {
    return this.operations.size;
  }
}

const basePage: CapturedPage = {
  title: 'Durable Smart Save',
  url: 'https://example.com/first',
  domain: 'example.com',
  description: 'Failure-safe bookmarking',
  h1: 'Durable Smart Save',
  visibleText: 'Never lose bookmarking intent.',
  classificationAllowed: true,
};

describe('SmartSaveService durability', () => {
  it('lazily creates one managed Pending Folder and reuses its persisted node id', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let operation = 0;
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => `operation-${++operation}` },
      jev: failingJev('temporarily-unavailable'),
    });

    const first = await service.start({ tabId: 1 });
    const second = await service.start({ tabId: 2 });

    expect(first).toMatchObject({
      status: 'pending',
      messageKey: 'classificationUnavailable',
      recoveryAction: 'retry',
      finalFolderPath: '待分类',
    });
    expect(second).toMatchObject({ status: 'pending', finalFolderId: first.finalFolderId });
    expect(storage.settingsSnapshot()).toMatchObject({ pendingFolderId: first.finalFolderId });

    const otherBookmarks = findNode(bookmarks.snapshot(), '2');
    expect(otherBookmarks?.children?.filter(({ title }) => title === '待分类')).toEqual([
      expect.objectContaining({ id: 'unrelated-pending', children: [] }),
      expect.objectContaining({
        id: first.finalFolderId,
        children: [
          expect.objectContaining({ url: 'https://example.com/first' }),
          expect.objectContaining({ url: 'https://example.com/second' }),
        ],
      }),
    ]);
  });

  it('serializes simultaneous first fallbacks into one managed Pending Folder', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let operation = 0;
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => `operation-simultaneous-${++operation}` },
      jev: failingJev('temporarily-unavailable'),
    });

    const [first, second] = await Promise.all([
      service.start({ tabId: 1 }),
      service.start({ tabId: 2 }),
    ]);

    expect(first.finalFolderId).toBe(second.finalFolderId);
    expect(findNode(bookmarks.snapshot(), '2')?.children?.filter(
      ({ id, title }) => id !== 'unrelated-pending' && title === '待分类',
    )).toHaveLength(1);
    expect(findNode(bookmarks.snapshot(), first.finalFolderId ?? '')?.children).toHaveLength(2);
  });

  it.each([
    {
      name: 'there are no Eligible Folders',
      excludedFolderIds: ['1', '2'],
      jev: {
        classify: async () => {
          throw new Error('JEV must not be called');
        },
        testKey: async () => undefined,
      } satisfies JevPort,
      messageKey: 'noEligibleFolders',
    },
    {
      name: 'JEV selects the no-match option',
      excludedFolderIds: [],
      jev: {
        classify: async () => ({
          choice: '__no_match__',
          confidence: 0.95,
          probabilities: { '1': 0.01, '10': 0.04, '2': 0, __no_match__: 0.95 },
        }),
        testKey: async () => undefined,
      } satisfies JevPort,
      messageKey: 'noMatchingFolder',
    },
  ])('preserves bookmark intent when $name', async ({ excludedFolderIds, jev, messageKey }) => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds,
    });
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'operation-fallback' },
      jev,
    });

    const result = await service.start({ tabId: 1 });

    expect(result).toMatchObject({
      status: 'pending',
      messageKey,
      recoveryAction: 'choose-folder-manually',
      saveMethod: 'pending',
    });
    expect(findNode(bookmarks.snapshot(), result.finalFolderId ?? '')?.children).toEqual([
      expect.objectContaining({ id: result.finalBookmarkId, url: basePage.url }),
    ]);
  });

  it.each([
    {
      code: 'invalid-key',
      messageKey: 'invalidApiKey',
      recoveryAction: 'repair-api-key',
    },
    {
      code: 'invalid-request',
      messageKey: 'invalidClassificationRequest',
      recoveryAction: 'choose-folder-manually',
    },
    {
      code: 'invalid-response',
      messageKey: 'malformedClassificationResponse',
      recoveryAction: 'retry',
    },
    {
      code: 'temporarily-unavailable',
      messageKey: 'classificationUnavailable',
      recoveryAction: 'retry',
    },
  ] as const)(
    'saves one Pending Folder bookmark and exposes the recovery for $code',
    async ({ code, messageKey, recoveryAction }) => {
      const bookmarks = new DurableBookmarks(bookmarkTree());
      const service = createService({
        bookmarks,
        storage: new DurableStorage({
          consent: 'granted',
          apiKey: 'jev-secret',
          excludedFolderIds: [],
        }),
        pages: pagesByTab(),
        ids: { next: () => `operation-${code}` },
        jev: failingJev(code),
      });

      const result = await service.start({ tabId: 1 });

      expect(result).toMatchObject({ status: 'pending', messageKey, recoveryAction });
      expect(findNode(bookmarks.snapshot(), result.finalFolderId ?? '')?.children).toEqual([
        expect.objectContaining({ id: result.finalBookmarkId, url: basePage.url }),
      ]);
    },
  );

  it.each(['network', 'timeout', 'rate-limit', 'overload'] as const)(
    'turns a terminal $retryClass after one retry into one recoverable Pending bookmark',
    async (retryClass) => {
      const bookmarks = new DurableBookmarks(bookmarkTree());
      const storage = new DurableStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      });
      const { jev, fetcher } = terminalRetryClient(retryClass);
      const service = createService({
        bookmarks,
        storage,
        pages: pagesByTab(),
        ids: { next: () => `operation-${retryClass}` },
        jev,
      });

      const result = await service.start({ tabId: 1 });

      expect(result).toMatchObject({
        status: 'pending',
        messageKey: 'classificationUnavailable',
        recoveryAction: 'retry',
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([
        expect.objectContaining({ id: result.finalBookmarkId }),
      ]);
    },
  );

  it('retries after worker restart by moving the same Pending Folder bookmark', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let shouldFail = true;
    const jev: JevPort = {
      classify: async () => {
        if (shouldFail) throw new JevClientError('temporarily-unavailable');
        return {
          choice: '10',
          confidence: 0.9,
          probabilities: { '1': 0.05, '10': 0.9, '2': 0, __no_match__: 0.05 },
        };
      },
      testKey: async () => undefined,
    };
    const ports = {
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'operation-retry' },
      jev,
    };
    const beforeRestart = createService(ports);

    const pending = await beforeRestart.start({ tabId: 1 });
    shouldFail = false;
    const afterRestart = createService(ports);
    const saved = await afterRestart.retryPending({ operationId: pending.id });

    expect(saved).toMatchObject({
      status: 'saved',
      finalBookmarkId: pending.finalBookmarkId,
      finalFolderId: '10',
      saveMethod: 'automatic',
      mutation: { bookmarkId: pending.finalBookmarkId, currentParentId: '10' },
    });
    expect(findNode(bookmarks.snapshot(), pending.finalFolderId ?? '')?.children).toEqual([]);
    expect(findNode(bookmarks.snapshot(), '10')?.children).toEqual([
      expect.objectContaining({ id: pending.finalBookmarkId, url: basePage.url }),
    ]);
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toHaveLength(1);
  });

  it('moves the Pending Folder bookmark after a successful retry needs manual confirmation', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let shouldFail = true;
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'operation-candidate-retry' },
      jev: {
        classify: async () => {
          if (shouldFail) throw new JevClientError('temporarily-unavailable');
          return {
            choice: '10',
            confidence: 0.79,
            probabilities: { '1': 0.05, '10': 0.75, '2': 0, __no_match__: 0.2 },
          };
        },
        testKey: async () => undefined,
      },
    });

    const pending = await service.start({ tabId: 1 });
    shouldFail = false;
    const candidates = await service.retryPending({ operationId: pending.id });
    const saved = await service.confirm({ operationId: pending.id, folderId: '10' });

    expect(candidates.status).toBe('candidates');
    expect(saved).toMatchObject({
      status: 'saved',
      finalBookmarkId: pending.finalBookmarkId,
      finalFolderId: '10',
      saveMethod: 'confirmed',
    });
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([
      expect.objectContaining({ id: pending.finalBookmarkId, parentId: '10' }),
    ]);
  });

  it('continues after popup closure and reuses one in-flight operation for duplicate starts', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let signalClassificationStarted!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      signalClassificationStarted = resolve;
    });
    let resolveClassification!: (result: {
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }) => void;
    const classification = new Promise<{
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }>((resolve) => {
      resolveClassification = resolve;
    });
    let classifyCalls = 0;
    let captureCalls = 0;
    let operation = 0;
    const service = createService({
      bookmarks,
      storage,
      pages: {
        inspect: async () => basePage,
        capture: async () => {
          captureCalls += 1;
          return basePage;
        },
      },
      ids: { next: () => `operation-concurrent-${++operation}` },
      jev: {
        classify: async () => {
          classifyCalls += 1;
          signalClassificationStarted();
          return classification;
        },
        testKey: async () => undefined,
      },
    });

    const popupRequest = service.start({ tabId: 1 });
    await classificationStarted;
    // The caller can disappear here; no popup-owned cancellation is connected to the operation.
    const repeatedRequest = service.start({ tabId: 1 });
    resolveClassification({
      choice: '10',
      confidence: 0.9,
      probabilities: { '1': 0.05, '10': 0.9, '2': 0, __no_match__: 0.05 },
    });

    const [popupResult, repeatedResult] = await Promise.all([popupRequest, repeatedRequest]);

    expect(repeatedResult).toEqual(popupResult);
    expect(popupResult.status).toBe('saved');
    expect(classifyCalls).toBe(1);
    expect(captureCalls).toBe(1);
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toHaveLength(1);
  });

  it('restores the Pending outcome when the popup is reopened on the same tab and URL', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let jevCalls = 0;
    let operation = 0;
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => `operation-reopen-${++operation}` },
      jev: {
        classify: async () => {
          jevCalls += 1;
          throw new JevClientError('invalid-key');
        },
        testKey: async () => undefined,
      },
    });

    const pending = await service.start({ tabId: 1 });
    const reopened = await service.start({ tabId: 1 });

    expect(reopened).toEqual(pending);
    expect(reopened.status).toBe('pending');
    expect(jevCalls).toBe(1);
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toHaveLength(1);
  });

  it('moves the same Pending bookmark after the user repairs an invalid API key', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'invalid-key',
      excludedFolderIds: [],
    });
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'operation-repaired-key' },
      jev: {
        classify: async (_request, apiKey) => {
          if (apiKey !== 'repaired-key') throw new JevClientError('invalid-key');
          return {
            choice: '10',
            confidence: 0.9,
            probabilities: { '1': 0.05, '10': 0.9, '2': 0, __no_match__: 0.05 },
          };
        },
        testKey: async () => undefined,
      },
    });

    const pending = await service.start({ tabId: 1 });
    await storage.saveSettings({
      ...(await storage.getSettings()),
      apiKey: 'repaired-key',
    });
    const saved = await service.retryPending({ operationId: pending.id });

    expect(pending.recoveryAction).toBe('repair-api-key');
    expect(saved).toMatchObject({
      status: 'saved',
      finalBookmarkId: pending.finalBookmarkId,
      finalFolderId: '10',
    });
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([
      expect.objectContaining({ id: pending.finalBookmarkId, parentId: '10' }),
    ]);
  });

  it('recreates and remembers the managed Pending Folder after external deletion', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let operation = 0;
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => `operation-recreate-${++operation}` },
      jev: failingJev('temporarily-unavailable'),
    });

    const first = await service.start({ tabId: 1 });
    await bookmarks.remove(first.finalFolderId ?? '');
    const replacement = await service.start({ tabId: 2 });

    expect(replacement.finalFolderId).not.toBe(first.finalFolderId);
    expect(storage.settingsSnapshot()).toMatchObject({
      pendingFolderId: replacement.finalFolderId,
    });
    expect(findNode(bookmarks.snapshot(), replacement.finalFolderId ?? '')?.children).toEqual([
      expect.objectContaining({ id: replacement.finalBookmarkId }),
    ]);
  });

  it('adopts only its tokenized Pending Folder after suspension before id persistence', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const token = 'operation-folder-create-crash';
    const orphan = await bookmarks.createFolderInOtherBookmarks(
      `待分类 · Smart Favorites ${token}`,
    );
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
      pendingFolderCreationToken: token,
    });
    const service = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'operation-after-folder-create-crash' },
      jev: failingJev('temporarily-unavailable'),
    });

    const pending = await service.start({ tabId: 1 });

    expect(pending.finalFolderId).toBe(orphan.id);
    expect(storage.settingsSnapshot()).toMatchObject({ pendingFolderId: orphan.id });
    expect(storage.settingsSnapshot()).not.toHaveProperty('pendingFolderCreationToken');
    expect(findNode(bookmarks.snapshot(), '2')?.children?.filter(
      ({ id, title }) => id !== 'unrelated-pending' && title === '待分类',
    )).toHaveLength(1);
  });

  it('stops with a retry prompt when navigation wins the capture race', async () => {
    let jevCalls = 0;
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    const service = createService({
      bookmarks,
      storage,
      pages: {
        inspect: async () => basePage,
        capture: async () => ({ ...basePage, url: 'https://example.com/navigated' }),
      },
      ids: { next: () => 'operation-navigation-before' },
      jev: {
        classify: async () => {
          jevCalls += 1;
          throw new Error('JEV must not be called');
        },
        testKey: async () => undefined,
      },
    });

    const result = await service.start({ tabId: 1 });

    expect(result).toMatchObject({
      status: 'capture-failed',
      messageKey: 'pageChangedBeforeCapture',
      recoveryAction: 'retry',
    });
    expect(jevCalls).toBe(0);
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([]);
  });

  it('preserves the captured page when navigation happens after capture', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    let activePage = basePage;
    let resolveClassification!: (result: {
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }) => void;
    const classification = new Promise<{
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }>((resolve) => {
      resolveClassification = resolve;
    });
    let capturedUrl = '';
    const service = createService({
      bookmarks,
      storage,
      pages: {
        inspect: async () => activePage,
        capture: async () => {
          const captured = activePage;
          capturedUrl = captured.url;
          return captured;
        },
      },
      ids: { next: () => 'operation-navigation-after' },
      jev: {
        classify: async (request) => {
          expect(request.page.url).toBe(basePage.url);
          return classification;
        },
        testKey: async () => undefined,
      },
    });

    const saving = service.start({ tabId: 1 });
    await viWaitFor(() => capturedUrl === basePage.url);
    activePage = { ...basePage, url: 'https://example.com/navigated-after-capture' };
    resolveClassification({
      choice: '10',
      confidence: 0.9,
      probabilities: { '1': 0.05, '10': 0.9, '2': 0, __no_match__: 0.05 },
    });

    const result = await saving;

    expect(result.status).toBe('saved');
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toHaveLength(1);
    expect(findBookmarksByUrl(bookmarks.snapshot(), activePage.url)).toEqual([]);
  });

  it('disables Smart Save in incognito without JEV, bookmark, or operation writes', async () => {
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    const calls = { tree: 0, create: 0, folder: 0, move: 0, remove: 0, jev: 0 };
    const bookmarks: BookmarkPort = {
      getTree: async () => {
        calls.tree += 1;
        return bookmarkTree();
      },
      create: async () => {
        calls.create += 1;
        throw new Error('must not create');
      },
      createFolderInOtherBookmarks: async () => {
        calls.folder += 1;
        throw new Error('must not create folder');
      },
      updateTitle: async () => {
        throw new Error('must not update');
      },
      move: async () => {
        calls.move += 1;
        throw new Error('must not move');
      },
      remove: async () => {
        calls.remove += 1;
        throw new Error('must not remove');
      },
    };
    const service = new SmartSaveService({
      bookmarks,
      storage,
      pages: {
        inspect: async () => ({
          ...basePage,
          classificationAllowed: false,
          restrictionReason: 'incognito',
        }),
        capture: async () => {
          throw new Error('must not capture');
        },
      },
      ids: { next: () => 'ephemeral-incognito' },
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      jev: {
        classify: async () => {
          calls.jev += 1;
          throw new Error('must not classify');
        },
        testKey: async () => undefined,
      },
    });

    const result = await service.start({ tabId: 1 });

    expect(result).toMatchObject({ status: 'disabled', messageKey: 'incognitoDisabled' });
    expect(calls).toEqual({ tree: 0, create: 0, folder: 0, move: 0, remove: 0, jev: 0 });
    expect(storage.operationCount()).toBe(0);
  });

  it('resumes a captured in-flight operation from durable state after worker restart', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    await storage.saveOperation({
      id: 'operation-suspended-worker',
      tabId: 1,
      status: 'classifying',
      page: basePage,
      folders: [],
      candidates: [],
      duplicateBookmarks: [],
      createdAt: '2026-09-22T08:00:00.000Z',
      captureCompleted: true,
    });
    let pageCalls = 0;
    const restartedService = createService({
      bookmarks,
      storage,
      pages: {
        inspect: async () => {
          pageCalls += 1;
          throw new Error('Captured operations must not inspect the navigated tab again');
        },
        capture: async () => {
          pageCalls += 1;
          throw new Error('Captured operations must not capture the navigated tab again');
        },
      },
      ids: { next: () => 'unused-id' },
      jev: {
        classify: async (request) => {
          expect(request.page.url).toBe(basePage.url);
          return {
            choice: '10',
            confidence: 0.9,
            probabilities: { '1': 0.05, '10': 0.9, '2': 0, __no_match__: 0.05 },
          };
        },
        testKey: async () => undefined,
      },
    });

    const [saved] = await restartedService.resumeInFlightOperations();

    expect(saved).toMatchObject({
      id: 'operation-suspended-worker',
      status: 'saved',
      finalFolderId: '10',
    });
    expect(pageCalls).toBe(0);
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toHaveLength(1);
  });

  it('finalizes an automatically created bookmark after suspension without duplicating it', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const operationId = 'operation-suspended-after-create';
    const created = await bookmarks.create({
      parentId: '10',
      title: `Smart Favorites save · ${operationId}`,
      url: basePage.url,
    });
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    await storage.saveOperation({
      id: operationId,
      tabId: 1,
      status: 'creating-bookmark',
      page: basePage,
      folders: [],
      candidates: [],
      duplicateBookmarks: [],
      createdAt: '2026-09-22T08:00:00.000Z',
      captureCompleted: true,
      bookmarkCreationIntent: {
        folderId: '10',
        folderPath: '书签栏 / 开发',
        saveMethod: 'automatic',
        temporaryTitle: `Smart Favorites save · ${operationId}`,
      },
    });
    const restartedService = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'unused-id' },
      jev: failingJev('temporarily-unavailable'),
    });

    const [saved] = await restartedService.resumeInFlightOperations();

    expect(saved).toMatchObject({
      status: 'saved',
      finalBookmarkId: created.id,
      mutation: { bookmarkId: created.id, title: basePage.title },
    });
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([
      expect.objectContaining({ id: created.id, title: basePage.title }),
    ]);
  });

  it('finalizes a completed Pending Folder move after suspension without moving twice', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const pendingFolder = await bookmarks.createFolderInOtherBookmarks('待分类');
    const bookmark = await bookmarks.create({
      parentId: pendingFolder.id,
      title: basePage.title,
      url: basePage.url,
    });
    await bookmarks.move(bookmark.id, { parentId: '10' });
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
      pendingFolderId: pendingFolder.id,
    });
    await storage.saveOperation({
      id: 'operation-suspended-after-move',
      tabId: 1,
      status: 'moving-pending',
      page: basePage,
      folders: [],
      candidates: [],
      duplicateBookmarks: [],
      createdAt: '2026-09-22T08:00:00.000Z',
      captureCompleted: true,
      finalBookmarkId: bookmark.id,
      finalFolderId: pendingFolder.id,
      finalFolderPath: '待分类',
      saveMethod: 'pending',
      mutation: {
        kind: 'created',
        bookmarkId: bookmark.id,
        title: basePage.title,
        url: basePage.url,
        currentParentId: pendingFolder.id,
      },
      pendingMoveIntent: {
        folderId: '10',
        folderPath: '书签栏 / 开发',
        saveMethod: 'automatic',
      },
    });
    const restartedService = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'unused-id' },
      jev: failingJev('temporarily-unavailable'),
    });

    const [saved] = await restartedService.resumeInFlightOperations();

    expect(saved).toMatchObject({
      status: 'saved',
      finalBookmarkId: bookmark.id,
      finalFolderId: '10',
      mutation: { bookmarkId: bookmark.id, currentParentId: '10' },
    });
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([
      expect.objectContaining({ id: bookmark.id, parentId: '10' }),
    ]);
  });

  it('reconciles a Pending Folder bookmark created just before worker suspension', async () => {
    const bookmarks = new DurableBookmarks(bookmarkTree());
    const folder = await bookmarks.createFolderInOtherBookmarks('待分类');
    const operationId = 'operation-suspended-during-pending-save';
    const temporaryTitle = `Smart Favorites pending · ${operationId}`;
    const createdBeforeSuspension = await bookmarks.create({
      parentId: folder.id,
      title: temporaryTitle,
      url: basePage.url,
    });
    const storage = new DurableStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
      pendingFolderId: folder.id,
    });
    await storage.saveOperation({
      id: operationId,
      tabId: 1,
      status: 'saving-pending',
      page: basePage,
      folders: [],
      candidates: [],
      duplicateBookmarks: [],
      createdAt: '2026-09-22T08:00:00.000Z',
      captureCompleted: true,
      messageKey: 'classificationUnavailable',
      recoveryAction: 'retry',
      finalFolderId: folder.id,
      finalFolderPath: '待分类',
      saveMethod: 'pending',
      pendingSaveIntent: {
        folderId: folder.id,
        title: basePage.title,
        temporaryTitle,
        url: basePage.url,
      },
    });
    const restartedService = createService({
      bookmarks,
      storage,
      pages: pagesByTab(),
      ids: { next: () => 'unused-id' },
      jev: failingJev('temporarily-unavailable'),
    });

    const [pending] = await restartedService.resumeInFlightOperations();

    expect(pending).toMatchObject({
      status: 'pending',
      finalBookmarkId: createdBeforeSuspension.id,
      finalFolderId: folder.id,
    });
    expect(findBookmarksByUrl(bookmarks.snapshot(), basePage.url)).toEqual([
      expect.objectContaining({ id: createdBeforeSuspension.id }),
    ]);
  });
});

function createService(input: {
  bookmarks: DurableBookmarks;
  storage: DurableStorage;
  pages: PagePort;
  ids: { next(): string };
  jev: JevPort;
}) {
  return new SmartSaveService({
    ...input,
    clock: { now: () => '2026-09-22T08:00:00.000Z' },
  });
}

function pagesByTab(): PagePort {
  const pageFor = (tabId: number): CapturedPage => ({
    ...basePage,
    title: `Page ${tabId}`,
    url: `https://example.com/${tabId === 1 ? 'first' : 'second'}`,
  });
  return {
    inspect: async (tabId) => pageFor(tabId),
    capture: async (tabId) => pageFor(tabId),
  };
}

function failingJev(code: JevClientError['code']): JevPort {
  return {
    classify: async () => {
      throw new JevClientError(code);
    },
    testKey: async () => undefined,
  };
}

function terminalRetryClient(retryClass: 'network' | 'timeout' | 'rate-limit' | 'overload') {
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  if (retryClass === 'network') {
    fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network offline'));
  } else if (retryClass === 'timeout') {
    fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
  } else {
    const status = retryClass === 'rate-limit' ? 429 : 529;
    fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () => new Response('', { status }),
    );
  }
  return {
    fetcher,
    jev: new HttpJevClient({
      fetcher,
      delay: async () => undefined,
      timeoutMs: retryClass === 'timeout' ? 1 : 10_000,
      random: () => 0,
    }),
  };
}

function bookmarkTree(): BookmarkNode[] {
  return [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          parentId: '0',
          title: '书签栏',
          children: [{ id: '10', parentId: '1', title: '开发', children: [] }],
        },
        {
          id: '2',
          parentId: '0',
          title: '其他书签',
          children: [
            {
              id: 'unrelated-pending',
              parentId: '2',
              title: '待分类',
              children: [],
            },
          ],
        },
      ],
    },
  ];
}

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function detachNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  const index = nodes.findIndex((node) => node.id === id);
  if (index >= 0) return nodes.splice(index, 1)[0];
  for (const node of nodes) {
    const found = detachNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function findBookmarksByUrl(nodes: BookmarkNode[], url: string): BookmarkNode[] {
  return nodes.flatMap((node) => [
    ...(node.url === url ? [node] : []),
    ...findBookmarksByUrl(node.children ?? [], url),
  ]);
}

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached');
}
