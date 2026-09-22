export const NO_MATCH_OPTION = '__no_match__';

export type ConsentDecision = 'unknown' | 'granted' | 'declined';

export interface Settings {
  consent: ConsentDecision;
  apiKey?: string;
  excludedFolderIds: string[];
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

export type OperationStatus =
  | 'consent-required'
  | 'classifying'
  | 'manual-selection'
  | 'candidates'
  | 'saved';

export interface OperationState {
  id: string;
  tabId: number;
  status: OperationStatus;
  page: CapturedPage;
  folders: EligibleFolder[];
  candidates: FolderCandidate[];
  createdAt: string;
  messageKey?: 'classificationUnavailable' | 'noEligibleFolders';
  finalBookmarkId?: string;
  finalFolderId?: string;
  finalFolderPath?: string;
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
  capture(tabId: number): Promise<CapturedPage>;
}

export interface BookmarkPort {
  getTree(): Promise<BookmarkNode[]>;
  create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode>;
}

export interface JevPort {
  classify(request: JevClassificationRequest, apiKey: string): Promise<JevClassificationResult>;
  testKey(apiKey: string): Promise<void>;
}

export interface SmartSaveStoragePort {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getOperation(id: string): Promise<OperationState | undefined>;
  saveOperation(operation: OperationState): Promise<void>;
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
