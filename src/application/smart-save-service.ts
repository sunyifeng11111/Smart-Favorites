import {
  NO_MATCH_OPTION,
  type BookmarkNode,
  type BookmarkMutation,
  type ClassificationCorrection,
  type CapturedPage,
  type DuplicateBookmarkLocation,
  type EligibleFolder,
  type JevClassificationRequest,
  type JevClassificationResult,
  type OperationState,
  type SmartSavePorts,
} from './types';
import { httpDomain } from '../shared/url';

const AUTOMATIC_CONFIDENCE_THRESHOLD = 0.8;
const AUTOMATIC_OPTION_PROBABILITY_THRESHOLD = 0.7;

export class SmartSaveService {
  constructor(private readonly ports: SmartSavePorts) {}

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

      const page = await this.ports.pages.capture(operation.tabId);
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
      const operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      if (operation.status === 'undone') return operation;
      if (operation.status !== 'saved' || !operation.mutation) {
        throw new Error('Saved bookmark is not changeable');
      }
      const folder = operation.folders.find(({ id }) => id === command.folderId);
      if (!folder) throw new Error('Selected folder is not eligible');
      if (operation.mutation.currentParentId === folder.id) return operation;

      const tree = await this.ports.bookmarks.getTree();
      const current = locateBookmark(tree, operation.mutation.bookmarkId);
      const destination = findTreeNode(tree, folder.id);
      if (
        !current ||
        !matchesExpectedBookmark(current.node, operation.mutation) ||
        !destination ||
        destination.url != null
      ) {
        return this.stopForExternalChange(operation);
      }

      await this.ports.bookmarks.move(operation.mutation.bookmarkId, { parentId: folder.id });
      const mutation = { ...operation.mutation, currentParentId: folder.id };
      const changed: OperationState = {
        ...operation,
        finalFolderId: folder.id,
        finalFolderPath: folder.path,
        mutation,
      };
      await this.ports.storage.saveOperation(changed);
      await this.recordCorrection(changed, folder.id);
      return changed;
    });
  }

  async undo(command: { operationId: string }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      const operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      if (operation.status === 'undone') return operation;
      if (operation.status !== 'saved' || !operation.mutation) {
        throw new Error('Smart Save operation cannot be undone');
      }

      const tree = await this.ports.bookmarks.getTree();
      const current = locateBookmark(tree, operation.mutation.bookmarkId);
      if (!current || !matchesExpectedBookmark(current.node, operation.mutation)) {
        return this.stopForExternalChange(operation);
      }

      if (operation.mutation.kind === 'moved-existing') {
        const originalParent = findTreeNode(tree, operation.mutation.originalParentId);
        if (!originalParent || originalParent.url != null) {
          return this.stopForExternalChange(operation);
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
        mutation: { ...operation.mutation, undone: true },
      };
      await this.ports.storage.saveOperation(undone);
      return undone;
    });
  }

  async decideConsent(command: {
    operationId: string;
    granted: boolean;
  }): Promise<OperationState> {
    const operation = await this.ports.storage.getOperation(command.operationId);
    if (!operation) throw new Error('Smart Save operation not found');

    const settings = await this.ports.storage.getSettings();
    const updatedSettings = {
      ...settings,
      consent: command.granted ? ('granted' as const) : ('declined' as const),
    };
    await this.ports.storage.saveSettings(updatedSettings);

    if (!command.granted || !updatedSettings.apiKey || !operation.page.classificationAllowed) {
      return this.showManualSelection(operation);
    }

    return this.classify(operation, updatedSettings.apiKey);
  }

  async confirm(command: { operationId: string; folderId: string }): Promise<OperationState> {
    return this.ports.storage.runOperationExclusive(command.operationId, async () => {
      const operation = await this.ports.storage.getOperation(command.operationId);
      if (!operation) throw new Error('Smart Save operation not found');
      if (operation.status === 'saved') return operation;

      const folder = operation.folders.find(({ id }) => id === command.folderId);
      if (!folder) throw new Error('Selected folder is not eligible');

      if (operation.selectedExistingBookmarkId) {
        return this.moveExistingBookmark(operation, folder);
      }
      return this.createBookmark(
        operation,
        folder,
        operation.duplicateResolution === 'create-copy' ? 'duplicate-copy' : 'confirmed',
      );
    });
  }

  async start(command: { tabId: number }): Promise<OperationState> {
    const inspectedPage = await this.ports.pages.inspect(command.tabId);
    const [tree, settings] = await Promise.all([
      this.ports.bookmarks.getTree(),
      this.ports.storage.getSettings(),
    ]);
    const folders = collectEligibleFolders(tree, new Set(settings.excludedFolderIds));
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

    const page = await this.ports.pages.capture(command.tabId);
    const capturedOperation: OperationState = { ...operation, page };
    await this.ports.storage.saveOperation(capturedOperation);

    return this.continueAfterCapture(capturedOperation, settings);
  }

  private async continueAfterCapture(
    operation: OperationState,
    knownSettings?: Awaited<ReturnType<SmartSavePorts['storage']['getSettings']>>,
  ): Promise<OperationState> {
    const settings = knownSettings ?? await this.ports.storage.getSettings();
    if (
      settings.consent !== 'granted' ||
      !settings.apiKey ||
      !operation.page.classificationAllowed
    ) {
      if (operation.page.classificationAllowed && settings.consent === 'unknown') {
        const consentState: OperationState = { ...operation, status: 'consent-required' };
        await this.ports.storage.saveOperation(consentState);
        return consentState;
      }
      return this.showManualSelection(operation);
    }
    return this.classify(operation, settings.apiKey);
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
    const winningFolder = operation.folders.find(({ id }) => id === result.choice);
    const winningProbability = result.probabilities[result.choice] ?? 0;
    if (
      winningFolder &&
      !operation.selectedExistingBookmarkId &&
      result.confidence >= AUTOMATIC_CONFIDENCE_THRESHOLD &&
      winningProbability >= AUTOMATIC_OPTION_PROBABILITY_THRESHOLD
    ) {
      return this.createBookmark(
        operation,
        winningFolder,
        operation.duplicateResolution === 'create-copy' ? 'duplicate-copy' : 'automatic',
      );
    }
    const candidateState: OperationState = {
      ...operation,
      status: 'candidates',
      candidates: operation.folders
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
        undone: false,
      },
    };
    await this.ports.storage.saveOperation(savedState);
    return savedState;
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
      return this.stopForExternalChange(operation);
    }

    await this.ports.bookmarks.move(selected.bookmarkId, { parentId: folder.id });
    const savedState: OperationState = {
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
        undone: false,
      },
    };
    await this.ports.storage.saveOperation(savedState);
    await this.recordCorrection(savedState, folder.id);
    return savedState;
  }

  private async stopForExternalChange(operation: OperationState): Promise<OperationState> {
    const stopped: OperationState = {
      ...operation,
      messageKey: 'bookmarkChangedExternally',
    };
    await this.ports.storage.saveOperation(stopped);
    return stopped;
  }

  private async recordCorrection(operation: OperationState, folderId: string): Promise<void> {
    if (!operation.finalBookmarkId) return;
    const correction: ClassificationCorrection = {
      operationId: operation.id,
      bookmarkId: operation.finalBookmarkId,
      title: operation.page.title,
      domain: httpDomain(operation.page.url) ?? '',
      folderId,
      createdAt: this.ports.clock.now(),
    };
    await this.ports.storage.saveClassificationCorrection(correction);
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
): EligibleFolder[] {
  const folders: EligibleFolder[] = [];

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
        examples: directBookmarkExamples(node.children ?? []),
      });
    }

    for (const child of node.children ?? []) {
      visit(child, path, isExcluded);
    }
  };

  for (const root of tree) visit(root, [], false);
  return folders;
}

function directBookmarkExamples(children: BookmarkNode[]) {
  return children
    .filter((child): child is BookmarkNode & { url: string } => typeof child.url === 'string')
    .sort((left, right) => (right.dateAdded ?? 0) - (left.dateAdded ?? 0))
    .flatMap((bookmark) => {
      const domain = httpDomain(bookmark.url);
      return domain == null ? [] : [{ title: bookmark.title, domain }];
    })
    .slice(0, 3);
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
