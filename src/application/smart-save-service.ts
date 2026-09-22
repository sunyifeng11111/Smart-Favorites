import {
  NO_MATCH_OPTION,
  type BookmarkNode,
  type CapturedPage,
  type EligibleFolder,
  type JevClassificationRequest,
  type JevClassificationResult,
  type OperationState,
  type SmartSavePorts,
} from './types';
import { httpDomain } from '../shared/url';

export class SmartSaveService {
  constructor(private readonly ports: SmartSavePorts) {}

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
      };
      await this.ports.storage.saveOperation(savedState);
      return savedState;
    });
  }

  async start(command: { tabId: number }): Promise<OperationState> {
    const [page, tree, settings] = await Promise.all([
      this.ports.pages.capture(command.tabId),
      this.ports.bookmarks.getTree(),
      this.ports.storage.getSettings(),
    ]);
    const folders = collectEligibleFolders(tree, new Set(settings.excludedFolderIds));
    const operation: OperationState = {
      id: this.ports.ids.next(),
      tabId: command.tabId,
      status: 'classifying',
      page,
      folders,
      candidates: [],
      createdAt: this.ports.clock.now(),
    };

    await this.ports.storage.saveOperation(operation);

    if (settings.consent !== 'granted' || !settings.apiKey || !page.classificationAllowed) {
      if (page.classificationAllowed && settings.consent === 'unknown') {
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
