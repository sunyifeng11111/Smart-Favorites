import {
  NO_MATCH_OPTION,
  type BookmarkNode,
  type BookmarkMutation,
  type CapturedPage,
  type DuplicateBookmarkLocation,
  type EligibleFolder,
  type FolderExclusionNode,
  type JevClassificationRequest,
  type JevClassificationResult,
  type OperationState,
  type SmartSavePorts,
  type StoredFolderExample,
} from './types';
import { httpDomain } from '../shared/url';

const AUTOMATIC_CONFIDENCE_THRESHOLD = 0.8;
const AUTOMATIC_OPTION_PROBABILITY_THRESHOLD = 0.7;

export class SmartSaveService {
  constructor(private readonly ports: SmartSavePorts) {}

  async getFolderExclusionTree(): Promise<FolderExclusionNode[]> {
    const [tree, settings] = await Promise.all([
      this.ports.bookmarks.getTree(),
      this.ports.storage.getSettings(),
    ]);
    return buildFolderExclusionTree(tree, new Set(settings.excludedFolderIds));
  }

  async setFolderExcluded(command: {
    folderId: string;
    excluded: boolean;
  }): Promise<FolderExclusionNode[]> {
    const [tree, settings] = await Promise.all([
      this.ports.bookmarks.getTree(),
      this.ports.storage.getSettings(),
    ]);
    const currentTree = buildFolderExclusionTree(tree, new Set(settings.excludedFolderIds));
    const target = findFolderExclusionNode(currentTree, command.folderId);
    if (!target) throw new Error('Folder exclusion target is not available');
    if (target.excludedByAncestor) {
      throw new Error('Descendant exclusions cannot override an excluded ancestor');
    }

    const affectedIds = new Set([target.id, ...collectFolderExclusionIds(target.children)]);
    const excludedFolderIds = settings.excludedFolderIds.filter((id) => !affectedIds.has(id));
    if (command.excluded) excludedFolderIds.push(target.id);
    const updatedSettings = { ...settings, excludedFolderIds };
    await this.ports.storage.saveSettings(updatedSettings);
    return buildFolderExclusionTree(tree, new Set(excludedFolderIds));
  }

  async resolveDuplicate(command: {
    operationId: string;
    action: 'preserve' | 'create-copy' | 'reclassify';
    bookmarkId?: string;
  }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      const operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      if (operation.status === 'duplicate-preserved') return operation;
      if (operation.status !== 'duplicate-warning') {
        throw new Error('Duplicate action is no longer available');
      }
      if (command.action === 'preserve') {
        const preservedState: OperationState = {
          ...operation,
          status: 'duplicate-preserved',
        };
        await this.ports.storage.saveOperation(preservedState);
        return preservedState;
      }

      const selectedExisting = command.action === 'reclassify'
        ? operation.duplicateBookmarks.find(({ bookmarkId }) => bookmarkId === command.bookmarkId)
        : undefined;
      if (command.action === 'reclassify' && !selectedExisting) {
        throw new Error('Existing Bookmark is not part of this duplicate warning');
      }

      const page = await this.ports.pages.capture(operation.tabId, operation.page.url);
      assertCapturedPageIdentity(operation.page.url, page.url);
      const continued: OperationState = {
        ...operation,
        status: 'classifying',
        page,
        duplicateResolution: command.action,
        ...(selectedExisting
          ? { selectedExistingBookmarkId: selectedExisting.bookmarkId }
          : {}),
      };
      await this.ports.storage.saveOperation(continued);
      return this.continueAfterCapture(continued);
    });
  }

  async changeDestination(command: {
    operationId: string;
    folderId: string;
  }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      let operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      operation = await this.completePendingFolderExample(operation);
      if (operation.status === 'undone') return operation;
      if (operation.status !== 'saved' || !operation.mutation) {
        throw new Error('Saved bookmark is not changeable');
      }
      operation = await this.refreshEligibleFolders(
        operation,
        await this.ports.storage.getSettings(),
      );
      const currentMutation = operation.mutation;
      if (!currentMutation) throw new Error('Saved bookmark mutation is missing');
      const folder = operation.folders.find(({ id }) => id === command.folderId);
      if (!folder) return this.stopWithMessage(operation, 'folderSelectionUnavailable');
      if (currentMutation.currentParentId === folder.id) return operation;

      const tree = await this.ports.bookmarks.getTree();
      const current = locateBookmark(tree, currentMutation.bookmarkId);
      const destination = findTreeNode(tree, folder.id);
      if (
        !current ||
        !matchesExpectedBookmark(current.node, currentMutation) ||
        !destination ||
        destination.url != null
      ) {
        return this.stopWithMessage(operation, 'bookmarkChangedExternally');
      }

      await this.ports.bookmarks.move(currentMutation.bookmarkId, { parentId: folder.id });
      const mutation = { ...currentMutation, currentParentId: folder.id };
      const changedWithoutCorrection: OperationState = {
        ...operation,
        finalFolderId: folder.id,
        finalFolderPath: folder.path,
        mutation,
      };
      return this.persistWithCorrection(changedWithoutCorrection, folder.id);
    });
  }

  async undo(command: { operationId: string }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      let operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      operation = await this.completePendingFolderExample(operation);
      if (operation.status === 'undone') return operation;
      if (operation.status !== 'saved' || !operation.mutation) {
        throw new Error('Smart Save operation cannot be undone');
      }

      const tree = await this.ports.bookmarks.getTree();
      const current = locateBookmark(tree, operation.mutation.bookmarkId);
      if (!current || !matchesExpectedBookmark(current.node, operation.mutation)) {
        return this.stopWithMessage(operation, 'bookmarkChangedExternally');
      }

      if (operation.mutation.kind === 'moved-existing') {
        const originalParent = findTreeNode(tree, operation.mutation.originalParentId);
        if (!originalParent || originalParent.url != null) {
          return this.stopWithMessage(operation, 'bookmarkChangedExternally');
        }
      }

      if (operation.mutation.kind === 'created') {
        await this.ports.bookmarks.remove(operation.mutation.bookmarkId);
      } else {
        await this.ports.bookmarks.move(operation.mutation.bookmarkId, {
          parentId: operation.mutation.originalParentId,
          index: operation.mutation.originalIndex,
        });
      }
      const undone: OperationState = {
        ...operation,
        status: 'undone',
      };
      await this.ports.storage.saveOperation(undone);
      return undone;
    });
  }

  async decideConsent(command: {
    operationId: string;
    granted: boolean;
  }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      const operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      if (
        operation.status === 'manual-selection' ||
        operation.status === 'candidates' ||
        operation.status === 'saved'
      ) {
        return operation;
      }
      if (operation.status !== 'consent-required') {
        throw new Error('Consent decision is not available');
      }

      const settings = await this.ports.storage.getSettings();
      const updatedSettings = {
        ...settings,
        consent: command.granted ? ('granted' as const) : ('declined' as const),
      };
      await this.ports.storage.saveSettings(updatedSettings);

      return this.continueAfterCapture(operation, updatedSettings);
    });
  }

  async confirm(command: { operationId: string; folderId: string }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      let operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      operation = await this.completePendingFolderExample(operation);
      if (operation.status === 'saved') return operation;
      if (operation.status !== 'candidates' && operation.status !== 'manual-selection') {
        throw new Error('Folder confirmation is not available');
      }
      operation = await this.refreshEligibleFolders(
        operation,
        await this.ports.storage.getSettings(),
      );

      const folder = operation.folders.find(({ id }) => id === command.folderId);
      if (!folder) return this.stopWithMessage(operation, 'folderSelectionUnavailable');

      if (operation.selectedExistingBookmarkId) {
        return this.moveExistingBookmark(operation, folder);
      }
      return this.createBookmark(
        operation,
        folder,
        operation.duplicateResolution === 'create-copy' ? 'duplicate-copy' : 'confirmed',
        'confirmed-save',
      );
    });
  }

  async start(command: { tabId: number }): Promise<OperationState> {
    const inspectedPage = await this.ports.pages.inspect(command.tabId);
    const [tree, settings, storedExamples] = await Promise.all([
      this.ports.bookmarks.getTree(),
      this.ports.storage.getSettings(),
      this.ports.storage.getFolderExamples(),
    ]);
    const folders = collectEligibleFolders(
      tree,
      new Set(settings.excludedFolderIds),
      storedExamples,
    );
    const duplicateBookmarks = findDuplicateBookmarks(tree, inspectedPage.url);
    const operation: OperationState = {
      id: this.ports.ids.next(),
      tabId: command.tabId,
      status: 'classifying',
      page: inspectedPage,
      folders,
      candidates: [],
      duplicateBookmarks,
      createdAt: this.ports.clock.now(),
    };

    await this.ports.storage.saveOperation(operation);

    if (duplicateBookmarks.length > 0) {
      const duplicateState: OperationState = { ...operation, status: 'duplicate-warning' };
      await this.ports.storage.saveOperation(duplicateState);
      return duplicateState;
    }

    const page = await this.ports.pages.capture(command.tabId, inspectedPage.url);
    assertCapturedPageIdentity(inspectedPage.url, page.url);
    const capturedOperation: OperationState = { ...operation, page };
    await this.ports.storage.saveOperation(capturedOperation);

    return this.continueAfterCapture(capturedOperation, settings, true);
  }

  private async continueAfterCapture(
    operation: OperationState,
    knownSettings?: Awaited<ReturnType<SmartSavePorts['storage']['getSettings']>>,
    foldersAreFresh = false,
  ): Promise<OperationState> {
    const settings = knownSettings ?? await this.ports.storage.getSettings();
    const currentOperation = foldersAreFresh
      ? operation
      : await this.refreshEligibleFolders(operation, settings);
    if (
      settings.consent !== 'granted' ||
      !settings.apiKey ||
      !currentOperation.page.classificationAllowed
    ) {
      if (currentOperation.page.classificationAllowed && settings.consent === 'unknown') {
        const consentState: OperationState = { ...currentOperation, status: 'consent-required' };
        await this.ports.storage.saveOperation(consentState);
        return consentState;
      }
      return this.showManualSelection(currentOperation);
    }
    return this.classify(currentOperation, settings.apiKey);
  }

  private async refreshEligibleFolders(
    operation: OperationState,
    settings: Awaited<ReturnType<SmartSavePorts['storage']['getSettings']>>,
  ): Promise<OperationState> {
    const [tree, storedExamples] = await Promise.all([
      this.ports.bookmarks.getTree(),
      this.ports.storage.getFolderExamples(),
    ]);
    const folders = collectEligibleFolders(
      tree,
      new Set(settings.excludedFolderIds),
      storedExamples,
    );
    const candidateProbabilities = new Map(
      operation.candidates.map(({ id, probability }) => [id, probability]),
    );
    return {
      ...operation,
      folders,
      candidates: folders.flatMap((folder) => {
        const probability = candidateProbabilities.get(folder.id);
        return probability == null ? [] : [{ ...folder, probability }];
      }),
    };
  }

  private async classify(operation: OperationState, apiKey: string): Promise<OperationState> {
    if (operation.folders.length === 0) {
      return this.showManualSelection(operation, 'noEligibleFolders');
    }

    const request = buildClassificationRequest(operation.page, operation.folders);
    let result: JevClassificationResult;
    try {
      result = await this.ports.jev.classify(request, apiKey);
    } catch {
      return this.showManualSelection(operation, 'classificationUnavailable');
    }
    const currentOperation = await this.refreshEligibleFolders(
      operation,
      await this.ports.storage.getSettings(),
    );
    if (currentOperation.folders.length === 0) {
      return this.showManualSelection(currentOperation, 'noEligibleFolders');
    }
    const winningFolder = currentOperation.folders.find(({ id }) => id === result.choice);
    const winningProbability = result.probabilities[result.choice] ?? 0;
    if (
      winningFolder &&
      !currentOperation.selectedExistingBookmarkId &&
      result.confidence >= AUTOMATIC_CONFIDENCE_THRESHOLD &&
      winningProbability >= AUTOMATIC_OPTION_PROBABILITY_THRESHOLD
    ) {
      return this.createBookmark(
        currentOperation,
        winningFolder,
        currentOperation.duplicateResolution === 'create-copy' ? 'duplicate-copy' : 'automatic',
      );
    }
    const candidateState: OperationState = {
      ...currentOperation,
      status: 'candidates',
      candidates: currentOperation.folders
        .map((folder) => ({
          ...folder,
          probability: result.probabilities[folder.id] ?? 0,
        }))
        .sort((left, right) => right.probability - left.probability)
        .slice(0, 3),
    };
    await this.ports.storage.saveOperation(candidateState);
    return candidateState;
  }

  private async createBookmark(
    operation: OperationState,
    folder: EligibleFolder,
    saveMethod: NonNullable<OperationState['saveMethod']>,
    folderExampleSource?: StoredFolderExample['source'],
  ): Promise<OperationState> {
    const bookmark = await this.ports.bookmarks.create({
      parentId: folder.id,
      title: operation.page.title,
      url: operation.page.url,
    });
    const savedState: OperationState = {
      ...operation,
      status: 'saved',
      finalBookmarkId: bookmark.id,
      finalFolderId: folder.id,
      finalFolderPath: folder.path,
      saveMethod,
      mutation: {
        kind: 'created',
        bookmarkId: bookmark.id,
        title: bookmark.title,
        url: bookmark.url ?? operation.page.url,
        currentParentId: bookmark.parentId ?? folder.id,
      },
    };
    if (!folderExampleSource) {
      await this.ports.storage.saveOperation(savedState);
      return savedState;
    }
    const pending: OperationState = {
      ...savedState,
      pendingFolderExample: this.buildFolderExample(
        savedState,
        folder.id,
        folderExampleSource,
      ),
    };
    await this.ports.storage.saveOperation(pending);
    return this.completePendingFolderExample(pending);
  }

  private async moveExistingBookmark(
    operation: OperationState,
    folder: EligibleFolder,
  ): Promise<OperationState> {
    const selected = operation.duplicateBookmarks.find(
      ({ bookmarkId }) => bookmarkId === operation.selectedExistingBookmarkId,
    );
    if (!selected) throw new Error('Existing Bookmark is not part of this operation');
    const tree = await this.ports.bookmarks.getTree();
    const current = locateBookmark(tree, selected.bookmarkId);
    const destination = findTreeNode(tree, folder.id);
    if (
      !current ||
      !destination ||
      destination.url != null ||
      current.node.parentId !== selected.parentId ||
      current.index !== selected.index ||
      current.node.title !== selected.title ||
      current.node.url !== selected.url
    ) {
      return this.stopWithMessage(operation, 'bookmarkChangedExternally');
    }

    await this.ports.bookmarks.move(selected.bookmarkId, { parentId: folder.id });
    const savedWithoutCorrection: OperationState = {
      ...operation,
      status: 'saved',
      finalBookmarkId: selected.bookmarkId,
      finalFolderId: folder.id,
      finalFolderPath: folder.path,
      saveMethod: 'existing-move',
      mutation: {
        kind: 'moved-existing',
        bookmarkId: selected.bookmarkId,
        title: selected.title,
        url: selected.url,
        originalParentId: selected.parentId,
        originalIndex: selected.index,
        currentParentId: folder.id,
      },
    };
    return this.persistWithCorrection(savedWithoutCorrection, folder.id);
  }

  private async stopWithMessage(
    operation: OperationState,
    messageKey: NonNullable<OperationState['messageKey']>,
  ): Promise<OperationState> {
    const stopped: OperationState = {
      ...operation,
      messageKey,
    };
    await this.ports.storage.saveOperation(stopped);
    return stopped;
  }

  private buildFolderExample(
    operation: OperationState & { finalBookmarkId?: string },
    folderId: string,
    source: StoredFolderExample['source'],
  ): StoredFolderExample {
    if (!operation.finalBookmarkId) throw new Error('Saved bookmark identity is missing');
    return {
      source,
      operationId: operation.id,
      bookmarkId: operation.finalBookmarkId,
      title: operation.page.title,
      domain: httpDomain(operation.page.url) ?? '',
      folderId,
      createdAt: this.ports.clock.now(),
    };
  }

  private async persistWithCorrection(
    operation: OperationState,
    folderId: string,
  ): Promise<OperationState> {
    const pending: OperationState = {
      ...operation,
      pendingFolderExample: this.buildFolderExample(
        operation,
        folderId,
        'classification-correction',
      ),
    };
    await this.ports.storage.saveOperation(pending);
    return this.completePendingFolderExample(pending);
  }

  private async completePendingFolderExample(operation: OperationState): Promise<OperationState> {
    if (!operation.pendingFolderExample) return operation;
    await this.ports.storage.saveFolderExample(operation.pendingFolderExample);
    const completed = { ...operation };
    delete completed.pendingFolderExample;
    await this.ports.storage.saveOperation(completed);
    return completed;
  }

  private async showManualSelection(
    operation: OperationState,
    messageKey?: OperationState['messageKey'],
  ): Promise<OperationState> {
    const manualState: OperationState = {
      ...operation,
      status: 'manual-selection',
      ...(messageKey ? { messageKey } : {}),
    };
    await this.ports.storage.saveOperation(manualState);
    return manualState;
  }
}

function buildClassificationRequest(
  page: CapturedPage,
  folders: EligibleFolder[],
): JevClassificationRequest {
  return {
    page: {
      title: page.title,
      url: page.url,
      domain: page.domain,
      description: page.description,
      h1: page.h1,
      visibleText: page.visibleText,
    },
    criteria: Object.fromEntries([
      ...folders.map((folder) => [
        folder.id,
        { path: folder.path, examples: folder.examples },
      ]),
      [NO_MATCH_OPTION, 'No existing folder is suitable'],
    ]),
  };
}

function collectEligibleFolders(
  tree: BookmarkNode[],
  excludedFolderIds: ReadonlySet<string>,
  storedExamples: StoredFolderExample[] = [],
): EligibleFolder[] {
  const folders: EligibleFolder[] = [];
  const bookmarksById = indexBookmarks(tree);

  const visit = (node: BookmarkNode, parentPath: string[], excluded: boolean): void => {
    const isFolder = node.url == null;
    const isExcluded = excluded || excludedFolderIds.has(node.id);
    const path = node.title ? [...parentPath, node.title] : parentPath;

    if (isFolder && node.title && !isExcluded) {
      folders.push({
        id: node.id,
        title: node.title,
        path: path.join(' / '),
        depth: path.length,
        examples: folderExamples(node, storedExamples, bookmarksById),
      });
    }

    for (const child of node.children ?? []) {
      visit(child, path, isExcluded);
    }
  };

  for (const root of tree) visit(root, [], false);
  return folders;
}

function indexBookmarks(tree: BookmarkNode[]): Map<string, BookmarkNode> {
  const bookmarks = new Map<string, BookmarkNode>();
  const visit = (node: BookmarkNode): void => {
    if (node.url != null) bookmarks.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of tree) visit(root);
  return bookmarks;
}

function folderExamples(
  folder: BookmarkNode,
  storedExamples: StoredFolderExample[],
  bookmarksById: ReadonlyMap<string, BookmarkNode>,
) {
  const selected: Array<{ title: string; domain: string }> = [];
  const selectedBookmarkIds = new Set<string>();
  const sourcePriority: Record<StoredFolderExample['source'], number> = {
    'classification-correction': 0,
    'confirmed-save': 1,
  };
  const prioritized = storedExamples
    .filter(({ folderId }) => folderId === folder.id)
    .sort((left, right) => {
      const bySource = sourcePriority[left.source] - sourcePriority[right.source];
      return bySource || right.createdAt.localeCompare(left.createdAt);
    });

  for (const record of prioritized) {
    const bookmark = bookmarksById.get(record.bookmarkId);
    if (!bookmark || bookmark.parentId !== folder.id || selectedBookmarkIds.has(bookmark.id)) {
      continue;
    }
    const domain = bookmark.url == null ? undefined : httpDomain(bookmark.url);
    if (!domain) continue;
    selectedBookmarkIds.add(bookmark.id);
    selected.push({ title: bookmark.title, domain });
    if (selected.length === 3) return selected;
  }

  const directBookmarks = (folder.children ?? [])
    .filter((child): child is BookmarkNode & { url: string } => typeof child.url === 'string')
    .sort((left, right) => (right.dateAdded ?? 0) - (left.dateAdded ?? 0));
  for (const bookmark of directBookmarks) {
    if (selectedBookmarkIds.has(bookmark.id)) continue;
    const domain = httpDomain(bookmark.url);
    if (!domain) continue;
    selectedBookmarkIds.add(bookmark.id);
    selected.push({ title: bookmark.title, domain });
    if (selected.length === 3) break;
  }
  return selected;
}

function buildFolderExclusionTree(
  tree: BookmarkNode[],
  excludedFolderIds: ReadonlySet<string>,
): FolderExclusionNode[] {
  const visit = (
    node: BookmarkNode,
    parentPath: string[],
    excludedByAncestor: boolean,
  ): FolderExclusionNode[] => {
    if (node.url != null) return [];
    const path = node.title ? [...parentPath, node.title] : parentPath;
    const explicitlyExcluded = excludedFolderIds.has(node.id);
    const children = (node.children ?? []).flatMap((child) => {
      return visit(child, path, excludedByAncestor || explicitlyExcluded);
    });
    if (!node.title) return children;
    return [
      {
        id: node.id,
        title: node.title,
        path: path.join(' / '),
        depth: path.length,
        descendantCount: countFolderExclusionNodes(children),
        excluded: explicitlyExcluded || excludedByAncestor,
        excludedByAncestor,
        children,
      },
    ];
  };

  return tree.flatMap((root) => visit(root, [], false));
}

function countFolderExclusionNodes(nodes: FolderExclusionNode[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + countFolderExclusionNodes(node.children),
    0,
  );
}

function collectFolderExclusionIds(nodes: FolderExclusionNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectFolderExclusionIds(node.children)]);
}

function findFolderExclusionNode(
  nodes: FolderExclusionNode[],
  id: string,
): FolderExclusionNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findFolderExclusionNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function findDuplicateBookmarks(
  tree: BookmarkNode[],
  pageUrl: string,
): DuplicateBookmarkLocation[] {
  const normalizedPageUrl = normalizeDuplicateUrl(pageUrl);
  if (!normalizedPageUrl) return [];
  const matches: DuplicateBookmarkLocation[] = [];

  const visit = (node: BookmarkNode, parentPath: string[], index: number): void => {
    if (node.url != null) {
      if (
        node.parentId != null &&
        normalizeDuplicateUrl(node.url) === normalizedPageUrl
      ) {
        matches.push({
          bookmarkId: node.id,
          parentId: node.parentId,
          index,
          title: node.title,
          url: node.url,
          folderPath: parentPath.join(' / '),
        });
      }
      return;
    }

    const path = node.title ? [...parentPath, node.title] : parentPath;
    node.children?.forEach((child, childIndex) => visit(child, path, childIndex));
  };

  tree.forEach((root, index) => visit(root, [], index));
  return matches;
}

function normalizeDuplicateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function locateBookmark(
  tree: BookmarkNode[],
  bookmarkId: string,
): { node: BookmarkNode; index: number } | undefined {
  for (const parent of tree) {
    const children = parent.children ?? [];
    const index = children.findIndex(({ id }) => id === bookmarkId);
    if (index >= 0) {
      const node = children[index];
      if (node) return { node, index };
    }
    const nested = locateBookmark(children, bookmarkId);
    if (nested) return nested;
  }
  return undefined;
}

function matchesExpectedBookmark(node: BookmarkNode, mutation: BookmarkMutation): boolean {
  return (
    node.id === mutation.bookmarkId &&
    node.parentId === mutation.currentParentId &&
    node.title === mutation.title &&
    node.url === mutation.url
  );
}

function findTreeNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findTreeNode(node.children ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}

function assertCapturedPageIdentity(expectedUrl: string, capturedUrl: string): void {
  if (capturedUrl !== expectedUrl) throw new Error('Page changed before capture completed');
}
