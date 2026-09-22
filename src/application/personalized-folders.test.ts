import { describe, expect, it } from 'vitest';

import { SmartSaveService } from './smart-save-service';
import type {
  BookmarkNode,
  BookmarkPort,
  CapturedPage,
  FolderExclusionNode,
  JevClassificationRequest,
  JevClassificationResult,
  OperationState,
  Settings,
  SmartSaveStoragePort,
  StoredFolderExample,
} from './types';

class PersonalizationBookmarks implements BookmarkPort {
  private createdCount = 0;

  constructor(private readonly tree: BookmarkNode[]) {}

  async getTree(): Promise<BookmarkNode[]> {
    return structuredClone(this.tree);
  }

  async create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode> {
    const parent = findNode(this.tree, input.parentId);
    if (!parent) throw new Error(`Missing parent ${input.parentId}`);
    this.createdCount += 1;
    const bookmark: BookmarkNode = {
      id: `created-${this.createdCount}`,
      ...input,
      dateAdded: 1_000 + this.createdCount,
    };
    parent.children ??= [];
    parent.children.push(bookmark);
    return structuredClone(bookmark);
  }

  async move(id: string, destination: { parentId: string; index?: number }): Promise<BookmarkNode> {
    const bookmark = detachNode(this.tree, id);
    const parent = findNode(this.tree, destination.parentId);
    if (!bookmark || !parent) throw new Error('Cannot move bookmark');
    bookmark.parentId = destination.parentId;
    parent.children ??= [];
    parent.children.splice(destination.index ?? parent.children.length, 0, bookmark);
    return structuredClone(bookmark);
  }

  async remove(id: string): Promise<void> {
    if (!detachNode(this.tree, id)) throw new Error(`Missing bookmark ${id}`);
  }

  renameFolder(id: string, title: string): void {
    const folder = findNode(this.tree, id);
    if (!folder || folder.url != null) throw new Error(`Missing folder ${id}`);
    folder.title = title;
  }
}

class PersonalizationStorage implements SmartSaveStoragePort {
  private readonly operations = new Map<string, OperationState>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  readonly examples: StoredFolderExample[];

  constructor(
    private settings: Settings,
    examples: StoredFolderExample[] = [],
  ) {
    this.examples = structuredClone(examples);
  }

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
    return structuredClone(this.examples);
  }

  async saveFolderExample(example: StoredFolderExample): Promise<void> {
    const identity = `${example.source}:${example.operationId}:${example.folderId}`;
    if (
      this.examples.some(
        (stored) => `${stored.source}:${stored.operationId}:${stored.folderId}` === identity,
      )
    ) {
      return;
    }
    this.examples.push(structuredClone(example));
  }

  async runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    this.operationQueues.set(id, result.then(() => undefined, () => undefined));
    return result;
  }
}

const page: CapturedPage = {
  title: 'TypeScript Handbook',
  url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
  domain: 'typescriptlang.org',
  description: 'The TypeScript handbook',
  h1: 'The TypeScript Handbook',
  visibleText: 'Learn the TypeScript language.',
  classificationAllowed: true,
};

describe('SmartSaveService personalized Eligible Folders', () => {
  it('shows exclusion impact and removes an excluded subtree from every classification surface', async () => {
    const bookmarks = new PersonalizationBookmarks(taxonomyTree());
    const storage = new PersonalizationStorage(grantedSettings());
    const requests: JevClassificationRequest[] = [];
    const service = createService({ bookmarks, storage, requests });

    const before = await service.getFolderExclusionTree();
    expect(folder(before, '1')).toMatchObject({
      path: '书签栏',
      descendantCount: 4,
      excluded: false,
      excludedByAncestor: false,
    });
    expect(folder(before, '100')).toMatchObject({
      path: '书签栏 / 工具 / 参考',
      descendantCount: 0,
    });
    expect(folder(before, '110')).toMatchObject({
      path: '书签栏 / 收藏 / 参考',
      descendantCount: 0,
    });

    const after = await service.setFolderExcluded({ folderId: '10', excluded: true });
    expect((await storage.getSettings()).excludedFolderIds).toEqual(['10']);
    expect(folder(after, '10')).toMatchObject({
      excluded: true,
      excludedByAncestor: false,
      descendantCount: 1,
    });
    expect(folder(after, '100')).toMatchObject({
      excluded: true,
      excludedByAncestor: true,
    });
    await expect(
      service.setFolderExcluded({ folderId: '100', excluded: false }),
    ).rejects.toThrow('Descendant exclusions cannot override an excluded ancestor');

    const result = await service.start({ tabId: 42 });

    expect(requests[0]?.criteria).toMatchObject({
      '1': { path: '书签栏' },
      '11': { path: '书签栏 / 收藏' },
      '110': { path: '书签栏 / 收藏 / 参考' },
      '2': { path: '其他书签' },
      __no_match__: 'No existing folder is suitable',
    });
    expect(requests[0]?.criteria).not.toHaveProperty('10');
    expect(requests[0]?.criteria).not.toHaveProperty('100');
    expect(result.folders.map(({ id }) => id)).toEqual(['1', '11', '110', '2']);
    expect(result.candidates.map(({ id }) => id)).not.toContain('10');
    expect(result.candidates.map(({ id }) => id)).not.toContain('100');

    const restored = await service.setFolderExcluded({ folderId: '10', excluded: false });
    expect((await storage.getSettings()).excludedFolderIds).toEqual([]);
    expect(folder(restored, '10')).toMatchObject({ excluded: false });
    expect(folder(restored, '100')).toMatchObject({ excluded: false });
  });

  it('keeps same-named folders distinct and includes empty and parent folders by node identity', async () => {
    const requests: JevClassificationRequest[] = [];
    const service = createService({
      bookmarks: new PersonalizationBookmarks(taxonomyTree()),
      storage: new PersonalizationStorage(grantedSettings()),
      requests,
    });

    const result = await service.start({ tabId: 42 });

    expect(requests[0]?.criteria).toMatchObject({
      '10': { path: '书签栏 / 工具' },
      '100': { path: '书签栏 / 工具 / 参考' },
      '11': { path: '书签栏 / 收藏' },
      '110': { path: '书签栏 / 收藏 / 参考' },
    });
    expect(result.folders.map(({ id }) => id)).toEqual(['1', '10', '100', '11', '110', '2']);
    expect(result.candidates.map(({ id }) => id)).toEqual(['110', '100', '10']);

    const saved = await service.confirm({ operationId: result.id, folderId: '100' });
    expect(saved).toMatchObject({
      finalFolderId: '100',
      finalFolderPath: '书签栏 / 工具 / 参考',
      mutation: { currentParentId: '100' },
    });
  });

  it('caps examples with correction, confirmed-save, then newest live direct-child precedence', async () => {
    const tree = taxonomyTree();
    const tools = findNode(tree, '10');
    if (!tools) throw new Error('Missing tools folder');
    tools.children = [
      ...(tools.children ?? []),
      bookmark('correction-live', '10', 'Current correction title', 'https://correct.example/new', 10),
      bookmark('confirmed-live', '10', 'Current confirmed title', 'https://confirmed.example/new', 20),
      bookmark('newest-existing', '10', 'Newest existing', 'https://new.example/', 300),
      bookmark('older-existing', '10', 'Older existing', 'https://old.example/', 200),
    ];
    const other = findNode(tree, '11');
    other?.children?.push(
      bookmark('moved-away', '11', 'Moved away', 'https://moved.example/', 400),
    );
    const storage = new PersonalizationStorage(grantedSettings(), [
      storedExample('classification-correction', 'correction-live', '10', '2026-09-20T10:00:00Z'),
      storedExample('confirmed-save', 'confirmed-live', '10', '2026-09-21T10:00:00Z'),
      storedExample('classification-correction', 'deleted-bookmark', '10', '2026-09-22T10:00:00Z'),
      storedExample('classification-correction', 'moved-away', '10', '2026-09-22T11:00:00Z'),
      storedExample('classification-correction', 'correction-live', 'deleted-folder', '2026-09-22T12:00:00Z'),
    ]);
    const bookmarks = new PersonalizationBookmarks(tree);
    const requests: JevClassificationRequest[] = [];
    const service = createService({ bookmarks, storage, requests });

    await service.start({ tabId: 42 });
    expect(requests[0]?.criteria['10']).toEqual({
      path: '书签栏 / 工具',
      examples: [
        { title: 'Current correction title', domain: 'correct.example' },
        { title: 'Current confirmed title', domain: 'confirmed.example' },
        { title: 'Newest existing', domain: 'new.example' },
      ],
    });

    bookmarks.renameFolder('10', '工程');
    await service.start({ tabId: 43 });
    expect(requests[1]?.criteria['10']).toEqual({
      path: '书签栏 / 工程',
      examples: [
        { title: 'Current correction title', domain: 'correct.example' },
        { title: 'Current confirmed title', domain: 'confirmed.example' },
        { title: 'Newest existing', domain: 'new.example' },
      ],
    });
  });

  it('uses a manually confirmed Smart Save as a future Folder Example', async () => {
    const bookmarks = new PersonalizationBookmarks(taxonomyTree());
    const storage = new PersonalizationStorage(grantedSettings());
    const requests: JevClassificationRequest[] = [];
    let operation = 0;
    const service = createService({
      bookmarks,
      storage,
      requests,
      nextId: () => `operation-${++operation}`,
    });

    const candidates = await service.start({ tabId: 42 });
    await service.confirm({ operationId: candidates.id, folderId: '10' });

    expect(storage.examples).toEqual([
      expect.objectContaining({
        source: 'confirmed-save',
        operationId: 'operation-1',
        bookmarkId: 'created-1',
        folderId: '10',
      }),
    ]);

    await service.start({ tabId: 43 });
    expect(requests[1]?.criteria['10']).toEqual({
      path: '书签栏 / 工具',
      examples: [{ title: page.title, domain: 'www.typescriptlang.org' }],
    });
  });

  it('refreshes exclusions, paths, and stale examples immediately before deferred classification', async () => {
    const tree = taxonomyTree();
    const tools = findNode(tree, '10');
    tools?.children?.push(
      bookmark('soon-deleted', '10', 'Soon deleted', 'https://stale.example/', 100),
    );
    const bookmarks = new PersonalizationBookmarks(tree);
    const storage = new PersonalizationStorage(
      { consent: 'unknown', apiKey: 'jev-secret', excludedFolderIds: [] },
      [storedExample('classification-correction', 'soon-deleted', '10', '2026-09-22T10:00:00Z')],
    );
    const requests: JevClassificationRequest[] = [];
    const service = createService({ bookmarks, storage, requests });

    const consent = await service.start({ tabId: 42 });
    expect(consent.status).toBe('consent-required');
    expect(requests).toHaveLength(0);

    bookmarks.renameFolder('10', '工程');
    await bookmarks.remove('soon-deleted');
    await service.setFolderExcluded({ folderId: '11', excluded: true });

    await service.decideConsent({ operationId: consent.id, granted: true });

    expect(requests[0]?.criteria['10']).toEqual({ path: '书签栏 / 工程', examples: [] });
    expect(requests[0]?.criteria).not.toHaveProperty('11');
    expect(requests[0]?.criteria).not.toHaveProperty('110');
  });

  it('keeps named folders manageable beneath an unnamed intermediate folder', async () => {
    const bookmarks = new PersonalizationBookmarks([
      {
        id: '0',
        title: '',
        children: [
          {
            id: 'unnamed-intermediate',
            parentId: '0',
            title: '',
            children: [
              { id: 'named-child', parentId: 'unnamed-intermediate', title: '资料', children: [] },
            ],
          },
        ],
      },
    ]);
    const service = createService({
      bookmarks,
      storage: new PersonalizationStorage(grantedSettings()),
      requests: [],
    });

    const settingsTree = await service.getFolderExclusionTree();

    expect(settingsTree).toEqual([
      expect.objectContaining({ id: 'named-child', path: '资料', excluded: false }),
    ]);
  });

  it('filters in-flight exclusions before candidates and rejects a newly excluded confirmation', async () => {
    const bookmarks = new PersonalizationBookmarks(taxonomyTree());
    const storage = new PersonalizationStorage(grantedSettings());
    let signalClassificationStarted!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      signalClassificationStarted = resolve;
    });
    let resolveClassification!: (result: JevClassificationResult) => void;
    const classificationResult = new Promise<JevClassificationResult>((resolve) => {
      resolveClassification = resolve;
    });
    const service = new SmartSaveService({
      pages: { inspect: async () => page, capture: async () => page },
      bookmarks,
      jev: {
        classify: async () => {
          signalClassificationStarted();
          return classificationResult;
        },
        testKey: async () => undefined,
      },
      storage,
      clock: { now: () => '2026-09-22T08:00:00.000Z' },
      ids: { next: () => 'operation-in-flight-exclusion' },
    });

    const pendingStart = service.start({ tabId: 42 });
    await classificationStarted;
    await service.setFolderExcluded({ folderId: '10', excluded: true });
    resolveClassification({
      choice: '110',
      confidence: 0.4,
      probabilities: {
        '1': 0.05,
        '10': 0.2,
        '100': 0.1,
        '11': 0.15,
        '110': 0.4,
        '2': 0.05,
        __no_match__: 0.05,
      },
    });

    const candidates = await pendingStart;
    expect(candidates.folders.map(({ id }) => id)).toEqual(['1', '11', '110', '2']);
    expect(candidates.candidates.map(({ id }) => id)).not.toContain('10');
    expect(candidates.candidates.map(({ id }) => id)).not.toContain('100');

    await service.setFolderExcluded({ folderId: '11', excluded: true });
    const refreshed = await service.confirm({ operationId: candidates.id, folderId: '110' });
    expect(refreshed).toMatchObject({
      status: 'candidates',
      messageKey: 'folderSelectionUnavailable',
    });
    expect(refreshed.folders.map(({ id }) => id)).toEqual(['1', '2']);
    expect(refreshed.candidates.map(({ id }) => id)).toEqual(['1']);
  });
});

function createService(options: {
  bookmarks: PersonalizationBookmarks;
  storage: PersonalizationStorage;
  requests: JevClassificationRequest[];
  nextId?: () => string;
}): SmartSaveService {
  const pageForTab = (tabId: number): CapturedPage =>
    tabId === 43
      ? {
          ...page,
          title: 'A different page',
          url: 'https://example.net/next',
          domain: 'example.net',
        }
      : page;
  return new SmartSaveService({
    pages: {
      inspect: async (tabId) => pageForTab(tabId),
      capture: async (tabId) => pageForTab(tabId),
    },
    bookmarks: options.bookmarks,
    jev: {
      classify: async (request) => {
        options.requests.push(structuredClone(request));
        return {
          choice: '110',
          confidence: 0.4,
          probabilities: {
            '1': 0.05,
            '10': 0.2,
            '100': 0.3,
            '11': 0.04,
            '110': 0.4,
            '2': 0.005,
            __no_match__: 0.005,
          },
        };
      },
      testKey: async () => undefined,
    },
    storage: options.storage,
    clock: { now: () => '2026-09-22T08:00:00.000Z' },
    ids: { next: options.nextId ?? (() => 'operation-personalization') },
  });
}

function taxonomyTree(): BookmarkNode[] {
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
              title: '工具',
              children: [{ id: '100', parentId: '10', title: '参考', children: [] }],
            },
            {
              id: '11',
              parentId: '1',
              title: '收藏',
              children: [{ id: '110', parentId: '11', title: '参考', children: [] }],
            },
          ],
        },
        { id: '2', parentId: '0', title: '其他书签', children: [] },
      ],
    },
  ];
}

function grantedSettings(): Settings {
  return { consent: 'granted', apiKey: 'jev-secret', excludedFolderIds: [] };
}

function bookmark(
  id: string,
  parentId: string,
  title: string,
  url: string,
  dateAdded: number,
): BookmarkNode {
  return { id, parentId, title, url, dateAdded };
}

function storedExample(
  source: StoredFolderExample['source'],
  bookmarkId: string,
  folderId: string,
  createdAt: string,
): StoredFolderExample {
  return {
    source,
    operationId: `${source}-${bookmarkId}-${folderId}`,
    bookmarkId,
    folderId,
    title: 'Stale stored title',
    domain: 'stale.example',
    createdAt,
  };
}

function folder(nodes: FolderExclusionNode[], id: string): FolderExclusionNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = folder(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}

function detachNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  const index = nodes.findIndex((node) => node.id === id);
  if (index >= 0) return nodes.splice(index, 1)[0];
  for (const node of nodes) {
    const nested = detachNode(node.children ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}
