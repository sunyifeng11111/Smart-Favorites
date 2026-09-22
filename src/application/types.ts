export const NO_MATCH_OPTION = '__no_match__';

export type ConsentDecision = 'unknown' | 'granted' | 'declined';

export interface Settings {
  consent: ConsentDecision;
  apiKey?: string;
  excludedFolderIds: string[];
  pendingFolderId?: string;
  pendingFolderCreationToken?: string;
}

export interface CapturedPage {
  title: string;
  url: string;
  domain: string;
  description: string;
  h1: string;
  visibleText: string;
  classificationAllowed: boolean;
  restrictionReason?: 'incognito' | 'unsupported-scheme';
}

export interface BookmarkNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  children?: BookmarkNode[];
  dateAdded?: number;
}

export interface FolderExample {
  title: string;
  domain: string;
}

export interface EligibleFolder {
  id: string;
  title: string;
  path: string;
  depth: number;
  examples: FolderExample[];
}

export interface FolderCandidate extends EligibleFolder {
  probability: number;
}

export interface FolderExclusionNode {
  id: string;
  title: string;
  path: string;
  depth: number;
  descendantCount: number;
  excluded: boolean;
  excludedByAncestor: boolean;
  children: FolderExclusionNode[];
}

export interface StoredFolderExample {
  source: 'classification-correction' | 'confirmed-save';
  operationId: string;
  bookmarkId: string;
  title: string;
  domain: string;
  folderId: string;
  createdAt: string;
}

export type OperationStatus =
  | 'consent-required'
  | 'classifying'
  | 'saving-pending'
  | 'creating-bookmark'
  | 'moving-pending'
  | 'capture-failed'
  | 'disabled'
  | 'duplicate-preserved'
  | 'duplicate-warning'
  | 'manual-selection'
  | 'candidates'
  | 'pending'
  | 'saved'
  | 'undone';

export interface DuplicateBookmarkLocation {
  bookmarkId: string;
  parentId: string;
  index: number;
  title: string;
  url: string;
  folderPath: string;
}

export type BookmarkMutation =
  | {
      kind: 'created';
      bookmarkId: string;
      title: string;
      url: string;
      currentParentId: string;
    }
  | {
      kind: 'moved-existing';
      bookmarkId: string;
      title: string;
      url: string;
      originalParentId: string;
      originalIndex: number;
      currentParentId: string;
    };

export type ClassificationCorrection = StoredFolderExample & {
  source: 'classification-correction';
};

export interface OperationState {
  id: string;
  tabId: number;
  status: OperationStatus;
  page: CapturedPage;
  folders: EligibleFolder[];
  candidates: FolderCandidate[];
  duplicateBookmarks: DuplicateBookmarkLocation[];
  createdAt: string;
  captureCompleted?: boolean;
  messageKey?:
    | 'classificationUnavailable'
    | 'invalidApiKey'
    | 'invalidClassificationRequest'
    | 'malformedClassificationResponse'
    | 'pageChangedBeforeCapture'
    | 'incognitoDisabled'
    | 'noEligibleFolders'
    | 'noMatchingFolder'
    | 'folderSelectionUnavailable'
    | 'bookmarkChangedExternally';
  recoveryAction?: 'retry' | 'repair-api-key' | 'choose-folder-manually';
  finalBookmarkId?: string;
  finalFolderId?: string;
  finalFolderPath?: string;
  saveMethod?: 'automatic' | 'confirmed' | 'duplicate-copy' | 'existing-move' | 'pending';
  duplicateResolution?: 'create-copy' | 'reclassify';
  selectedExistingBookmarkId?: string;
  mutation?: BookmarkMutation;
  pendingFolderExample?: StoredFolderExample;
  pendingSaveIntent?: {
    folderId: string;
    title: string;
    temporaryTitle: string;
    url: string;
    bookmarkId?: string;
  };
  bookmarkCreationIntent?: {
    folderId: string;
    folderPath: string;
    saveMethod: NonNullable<OperationState['saveMethod']>;
    folderExampleSource?: StoredFolderExample['source'];
    temporaryTitle: string;
    bookmarkId?: string;
  };
  pendingMoveIntent?: {
    folderId: string;
    folderPath: string;
    saveMethod: 'automatic' | 'confirmed';
    folderExampleSource?: StoredFolderExample['source'];
  };
}

export interface JevClassificationRequest {
  page: Omit<CapturedPage, 'classificationAllowed' | 'restrictionReason'>;
  criteria: Record<string, string | { path: string; examples: FolderExample[] }>;
}

export interface JevClassificationResult {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface PagePort {
  inspect(tabId: number): Promise<CapturedPage>;
  capture(tabId: number, expectedUrl: string): Promise<CapturedPage>;
}

export interface BookmarkPort {
  getTree(): Promise<BookmarkNode[]>;
  create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode>;
  createFolderInOtherBookmarks(title: string): Promise<BookmarkNode>;
  updateTitle(id: string, title: string): Promise<BookmarkNode>;
  move(id: string, destination: { parentId: string; index?: number }): Promise<BookmarkNode>;
  remove(id: string): Promise<void>;
}

export interface JevPort {
  classify(request: JevClassificationRequest, apiKey: string): Promise<JevClassificationResult>;
  testKey(apiKey: string): Promise<void>;
}

export interface SmartSaveStoragePort {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getOperation(id: string): Promise<OperationState | undefined>;
  getActiveOperation(tabId: number, url: string): Promise<OperationState | undefined>;
  getInFlightOperations(): Promise<OperationState[]>;
  saveOperation(operation: OperationState): Promise<void>;
  getFolderExamples(): Promise<StoredFolderExample[]>;
  saveFolderExample(example: StoredFolderExample): Promise<void>;
  runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T>;
}

export interface ClockPort {
  now(): string;
}

export interface IdPort {
  next(): string;
}

export interface SmartSavePorts {
  pages: PagePort;
  bookmarks: BookmarkPort;
  jev: JevPort;
  storage: SmartSaveStoragePort;
  clock: ClockPort;
  ids: IdPort;
}
