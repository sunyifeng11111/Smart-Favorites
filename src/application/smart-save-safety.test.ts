import { describe, expect, it } from 'vitest';

import { SmartSaveService } from './smart-save-service';
import type {
  BookmarkNode,
  BookmarkPort,
  CapturedPage,
  ClassificationCorrection,
  JevPort,
  OperationState,
  PagePort,
  Settings,
  SmartSaveStoragePort,
  StoredFolderExample,
} from './types';

class SafetyBookmarks implements BookmarkPort {
  private createdCount = 0;

  constructor(
    private readonly tree: BookmarkNode[],
    private readonly events: string[] = [],
  ) {}

  async getTree(): Promise<BookmarkNode[]> {
    this.events.push('tree');
    return structuredClone(this.tree);
  }

  async create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode> {
    this.events.push('create');
    const parent = findNode(this.tree, input.parentId);
    if (!parent) throw new Error(`Missing parent ${input.parentId}`);
    this.createdCount += 1;
    const bookmark = { id: `created-${this.createdCount}`, ...input };
    parent.children ??= [];
    parent.children.push(bookmark);
    return structuredClone(bookmark);
  }

  async createFolderInOtherBookmarks(title: string): Promise<BookmarkNode> {
    this.events.push('create-folder');
    const parent = findNode(this.tree, '2');
    if (!parent) throw new Error('Missing Other Bookmarks root');
    this.createdCount += 1;
    const folder = {
      id: `created-${this.createdCount}`,
      parentId: '2',
      title,
      children: [],
    };
    parent.children ??= [];
    parent.children.push(folder);
    return structuredClone(folder);
  }

  async updateTitle(id: string, title: string): Promise<BookmarkNode> {
    const node = findNode(this.tree, id);
    if (!node) throw new Error(`Missing node ${id}`);
    node.title = title;
    return structuredClone(node);
  }

  async move(id: string, destination: { parentId: string; index?: number }): Promise<BookmarkNode> {
    this.events.push('move');
    const located = detachNode(this.tree, id);
    if (!located) throw new Error(`Missing bookmark ${id}`);
    const parent = findNode(this.tree, destination.parentId);
    if (!parent) throw new Error(`Missing parent ${destination.parentId}`);
    located.parentId = destination.parentId;
    parent.children ??= [];
    parent.children.splice(destination.index ?? parent.children.length, 0, located);
    return structuredClone(located);
  }

  async remove(id: string): Promise<void> {
    this.events.push('remove');
    if (!detachNode(this.tree, id)) throw new Error(`Missing bookmark ${id}`);
  }

  externalMove(id: string, parentId: string): void {
    const located = detachNode(this.tree, id);
    const parent = findNode(this.tree, parentId);
    if (!located || !parent) throw new Error('Invalid external move');
    located.parentId = parentId;
    parent.children ??= [];
    parent.children.push(located);
  }

  snapshot(): BookmarkNode[] {
    return structuredClone(this.tree);
  }
}

class SafetyStorage implements SmartSaveStoragePort {
  private readonly operations = new Map<string, OperationState>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  readonly corrections: ClassificationCorrection[] = [];
  private correctionFailuresRemaining = 0;

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
    return structuredClone([...this.operations.values()].find(
      (operation) =>
        operation.tabId === tabId &&
        operation.page.url === url &&
        operation.status !== 'saved' &&
        operation.status !== 'undone' &&
        operation.status !== 'duplicate-preserved' &&
        operation.status !== 'disabled' &&
        operation.status !== 'capture-failed',
    ));
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
    return this.corrections.map((correction) => ({
      ...structuredClone(correction),
      source: 'classification-correction',
    }));
  }

  async saveFolderExample(example: StoredFolderExample): Promise<void> {
    if (example.source !== 'classification-correction') return;
    if (this.correctionFailuresRemaining > 0) {
      this.correctionFailuresRemaining -= 1;
      throw new Error('temporary correction storage failure');
    }
    if (
      this.corrections.some(
        (stored) =>
          stored.operationId === example.operationId &&
          stored.folderId === example.folderId,
      )
    ) {
      return;
    }
    this.corrections.push({ ...structuredClone(example), source: 'classification-correction' });
  }

  async runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    this.operationQueues.set(id, result.then(() => undefined, () => undefined));
    return result;
  }

  failNextCorrection(): void {
    this.correctionFailuresRemaining = 1;
  }
}

const page: CapturedPage = {
  title: 'Example',
  url: 'https://example.com/path?q=1#current',
  domain: 'example.com',
  description: 'description',
  h1: 'Heading',
  visibleText: 'Body',
  classificationAllowed: true,
};

describe('SmartSaveService mutation safety', () => {
  it('warns about every normalized Duplicate Bookmark before capture or JEV', async () => {
    const events: string[] = [];
    const bookmarks = new SafetyBookmarks([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            parentId: '0',
            title: '书签栏',
            children: [
              {
                id: '10',
                parentId: '1',
                title: '开发',
                children: [
                  {
                    id: 'existing-1',
                    parentId: '10',
                    title: 'First',
                    url: 'HTTPS://EXAMPLE.COM:443/path?q=1#old',
                  },
                  {
                    id: 'different-query',
                    parentId: '10',
                    title: 'Different query',
                    url: 'https://example.com/path?q=2',
                  },
                ],
              },
              {
                id: '11',
                parentId: '1',
                title: '阅读',
                children: [
                  {
                    id: 'existing-2',
                    parentId: '11',
                    title: 'Second',
                    url: 'https://example.com/path?q=1',
                  },
                  {
                    id: 'different-path',
                    parentId: '11',
                    title: 'Different path',
                    url: 'https://example.com/path/other?q=1',
                  },
                ],
              },
            ],
          },
        ],
      },
    ], events);
    const pages: PagePort = {
      inspect: async () => {
        events.push('inspect');
        return { ...page, description: '', h1: '', visibleText: '' };
      },
      capture: async () => {
        events.push('capture');
        return page;
      },
    };
    const jev: JevPort = {
      classify: async () => {
        events.push('jev');
        throw new Error('JEV must not be called');
      },
      testKey: async () => undefined,
    };
    const service = new SmartSaveService({
      pages,
      bookmarks,
      jev,
      storage: new SafetyStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-safety-1' },
    });

    const result = await service.start({ tabId: 42 });

    expect(result).toMatchObject({
      status: 'duplicate-warning',
      duplicateBookmarks: [
        { bookmarkId: 'existing-1', folderPath: '书签栏 / 开发', index: 0 },
        { bookmarkId: 'existing-2', folderPath: '书签栏 / 阅读', index: 0 },
      ],
    });
    expect(events).toEqual(['inspect', 'tree']);
  });

  it('preserves Existing Bookmarks without capture, JEV, or mutation', async () => {
    const events: string[] = [];
    const bookmarks = new SafetyBookmarks(duplicateTree(), events);
    const service = new SmartSaveService({
      pages: {
        inspect: async () => ({ ...page, description: '', h1: '', visibleText: '' }),
        capture: async () => {
          events.push('capture');
          return page;
        },
      },
      bookmarks,
      jev: {
        classify: async () => {
          events.push('jev');
          throw new Error('JEV must not be called');
        },
        testKey: async () => undefined,
      },
      storage: new SafetyStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-safety-2' },
    });

    const warning = await service.start({ tabId: 42 });
    const before = bookmarks.snapshot();
    await expect(
      service.confirm({ operationId: warning.id, folderId: '10' }),
    ).rejects.toThrow('Folder confirmation is not available');
    await expect(
      service.decideConsent({ operationId: warning.id, granted: true }),
    ).rejects.toThrow('Consent decision is not available');
    const preserved = await service.resolveDuplicate({
      operationId: warning.id,
      action: 'preserve',
    });

    expect(preserved.status).toBe('duplicate-preserved');
    await expect(
      service.confirm({ operationId: warning.id, folderId: '10' }),
    ).rejects.toThrow('Folder confirmation is not available');
    expect(bookmarks.snapshot()).toEqual(before);
    expect(events).toEqual(['tree']);
  });

  it.each([
    { confidence: 0.8, probability: 0.7, expectedStatus: 'saved', creates: true },
    { confidence: 0.7999, probability: 0.7, expectedStatus: 'candidates', creates: false },
    { confidence: 0.8, probability: 0.6999, expectedStatus: 'candidates', creates: false },
  ] as const)(
    'applies both Automatic Save thresholds at confidence $confidence and probability $probability',
    async ({ confidence, probability, expectedStatus, creates }) => {
      const events: string[] = [];
      const bookmarks = new SafetyBookmarks(emptyFolderTree(), events);
      const service = new SmartSaveService({
        pages: { inspect: async () => page, capture: async () => page },
        bookmarks,
        jev: {
          classify: async () => ({
            choice: '10',
            confidence,
            probabilities: { '10': probability, __no_match__: 1 - probability },
          }),
          testKey: async () => undefined,
        },
        storage: new SafetyStorage({
          consent: 'granted',
          apiKey: 'jev-secret',
          excludedFolderIds: [],
        }),
        clock: { now: () => '2026-09-22T08:00:00.000Z' },
        ids: { next: () => 'operation-threshold' },
      });

      const result = await service.start({ tabId: 42 });

      expect(result.status).toBe(expectedStatus);
      expect(events.includes('create')).toBe(creates);
      if (creates) {
        expect(result).toMatchObject({
          finalBookmarkId: 'created-1',
          finalFolderId: '10',
          finalFolderPath: '书签栏 / 开发',
        });
      }
    },
  );

  it('stops when the tab URL changes between duplicate inspection and page capture', async () => {
    const events: string[] = [];
    const bookmarks = new SafetyBookmarks(emptyFolderTree(), events);
    const service = new SmartSaveService({
      pages: {
        inspect: async () => page,
        capture: async () => ({ ...page, url: 'https://example.com/navigated' }),
      },
      bookmarks,
      jev: {
        classify: async () => {
          events.push('jev');
          throw new Error('JEV must not be called');
        },
        testKey: async () => undefined,
      },
      storage: new SafetyStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-navigation-race' },
    });

    await expect(service.start({ tabId: 42 })).resolves.toMatchObject({
      status: 'capture-failed',
      messageKey: 'pageChangedBeforeCapture',
      recoveryAction: 'retry',
    });
    expect(events).toEqual(['tree']);
  });

  it('serializes repeated consent decisions so Automatic Save creates one bookmark', async () => {
    let jevCalls = 0;
    const bookmarks = new SafetyBookmarks(emptyFolderTree());
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => {
          jevCalls += 1;
          return {
            choice: '10',
            confidence: 0.9,
            probabilities: { '10': 0.9, '11': 0.05, __no_match__: 0.05 },
          };
        },
        testKey: async () => undefined,
      },
      storage: new SafetyStorage({
        consent: 'unknown',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-consent-race' },
    });

    const disclosure = await service.start({ tabId: 42 });
    const [first, repeated] = await Promise.all([
      service.decideConsent({ operationId: disclosure.id, granted: true }),
      service.decideConsent({ operationId: disclosure.id, granted: true }),
    ]);

    expect(first).toEqual(repeated);
    expect(jevCalls).toBe(1);
    expect(findNode(bookmarks.snapshot(), '10')?.children).toHaveLength(1);
  });

  it('creates an intentional duplicate only after the user explicitly allows a copy', async () => {
    const events: string[] = [];
    const bookmarks = new SafetyBookmarks(duplicateTree(), events);
    const service = new SmartSaveService({
      pages: {
        inspect: async () => ({ ...page, description: '', h1: '', visibleText: '' }),
        capture: async () => {
          events.push('capture');
          return page;
        },
      },
      bookmarks,
      jev: {
        classify: async () => {
          events.push('jev');
          return {
            choice: '10',
            confidence: 0.9,
            probabilities: { '10': 0.9, __no_match__: 0.1 },
          };
        },
        testKey: async () => undefined,
      },
      storage: new SafetyStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-copy' },
    });

    const warning = await service.start({ tabId: 42 });
    expect(findNode(bookmarks.snapshot(), '10')?.children).toHaveLength(1);

    const copied = await service.resolveDuplicate({
      operationId: warning.id,
      action: 'create-copy',
    });

    expect(copied).toMatchObject({ status: 'saved', saveMethod: 'duplicate-copy' });
    expect(findNode(bookmarks.snapshot(), '10')?.children).toHaveLength(2);
    expect(events.slice(0, 2)).toEqual(['tree', 'capture']);
    expect(events.indexOf('jev')).toBeLessThan(events.indexOf('create'));
  });

  it('moves a chosen Existing Bookmark only after destination confirmation and Undo restores its index', async () => {
    const events: string[] = [];
    const bookmarks = new SafetyBookmarks(duplicateTree(), events);
    const storage = new SafetyStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => ({
          choice: '11',
          confidence: 0.95,
          probabilities: { '10': 0.02, '11': 0.95, __no_match__: 0.03 },
        }),
        testKey: async () => undefined,
      },
      storage,
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-existing-move' },
    });

    const warning = await service.start({ tabId: 42 });
    const candidates = await service.resolveDuplicate({
      operationId: warning.id,
      action: 'reclassify',
      bookmarkId: 'existing-1',
    });

    expect(candidates.status).toBe('candidates');
    expect(findNode(bookmarks.snapshot(), 'existing-1')?.parentId).toBe('10');

    const moved = await service.confirm({ operationId: warning.id, folderId: '11' });
    expect(moved).toMatchObject({
      status: 'saved',
      saveMethod: 'existing-move',
      mutation: {
        kind: 'moved-existing',
        originalParentId: '10',
        originalIndex: 0,
        currentParentId: '11',
      },
    });
    expect(findNode(bookmarks.snapshot(), 'existing-1')?.parentId).toBe('11');

    const undone = await service.undo({ operationId: warning.id });
    const repeated = await service.undo({ operationId: warning.id });
    expect(undone.status).toBe('undone');
    expect(repeated).toEqual(undone);
    expect(findNode(bookmarks.snapshot(), '10')?.children?.[0]?.id).toBe('existing-1');
    expect(storage.corrections).toEqual([
      expect.objectContaining({ bookmarkId: 'existing-1', folderId: '11' }),
    ]);
  });

  it('changes the destination of the same new bookmark, records the correction, and undoes once', async () => {
    const bookmarks = new SafetyBookmarks(emptyFolderTree());
    const storage = new SafetyStorage({
      consent: 'granted',
      apiKey: 'jev-secret',
      excludedFolderIds: [],
    });
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => ({
          choice: '10',
          confidence: 0.9,
          probabilities: { '10': 0.9, '11': 0.05, __no_match__: 0.05 },
        }),
        testKey: async () => undefined,
      },
      storage,
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-change' },
    });

    const automatic = await service.start({ tabId: 42 });
    storage.failNextCorrection();
    await expect(
      service.changeDestination({ operationId: automatic.id, folderId: '11' }),
    ).rejects.toThrow('temporary correction storage failure');
    const changed = await service.changeDestination({
      operationId: automatic.id,
      folderId: '11',
    });
    const repeated = await service.changeDestination({
      operationId: automatic.id,
      folderId: '11',
    });

    expect(changed.finalBookmarkId).toBe(automatic.finalBookmarkId);
    expect(repeated).toEqual(changed);
    expect(findNode(bookmarks.snapshot(), '10')?.children).toHaveLength(0);
    expect(findNode(bookmarks.snapshot(), '11')?.children).toEqual([
      expect.objectContaining({ id: 'created-1', url: page.url }),
    ]);
    expect(storage.corrections).toEqual([
      expect.objectContaining({ bookmarkId: 'created-1', folderId: '11' }),
    ]);

    const undone = await service.undo({ operationId: automatic.id });
    const repeatedUndo = await service.undo({ operationId: automatic.id });
    expect(undone.status).toBe('undone');
    expect(repeatedUndo).toEqual(undone);
    expect(findNode(bookmarks.snapshot(), 'created-1')).toBeUndefined();
  });

  it('stops Undo safely when the affected bookmark was changed or deleted externally', async () => {
    const bookmarks = new SafetyBookmarks(emptyFolderTree());
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => ({
          choice: '10',
          confidence: 0.9,
          probabilities: { '10': 0.9, '11': 0.05, __no_match__: 0.05 },
        }),
        testKey: async () => undefined,
      },
      storage: new SafetyStorage({
        consent: 'granted',
        apiKey: 'jev-secret',
        excludedFolderIds: [],
      }),
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-external-change' },
    });

    const automatic = await service.start({ tabId: 42 });
    bookmarks.externalMove('created-1', '11');
    const result = await service.undo({ operationId: automatic.id });

    expect(result).toMatchObject({ status: 'saved', messageKey: 'bookmarkChangedExternally' });
    expect(findNode(bookmarks.snapshot(), 'created-1')?.parentId).toBe('11');

    await bookmarks.remove('created-1');
    const afterDeletion = await service.undo({ operationId: automatic.id });
    expect(afterDeletion).toMatchObject({
      status: 'saved',
      messageKey: 'bookmarkChangedExternally',
    });
    expect(findNode(bookmarks.snapshot(), 'created-1')).toBeUndefined();
  });
});

function duplicateTree(): BookmarkNode[] {
  return [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          parentId: '0',
          title: '书签栏',
          children: [
            {
              id: '10',
              parentId: '1',
              title: '开发',
              children: [
                {
                  id: 'existing-1',
                  parentId: '10',
                  title: 'Existing',
                  url: 'https://example.com/path?q=1#old',
                },
              ],
            },
            { id: '11', parentId: '1', title: '阅读', children: [] },
          ],
        },
      ],
    },
  ];
}

function emptyFolderTree(): BookmarkNode[] {
  return [
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
            { id: '11', parentId: '1', title: '阅读', children: [] },
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
