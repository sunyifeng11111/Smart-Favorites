import type { OperationState } from './types';

const MAX_RECENT_RECORDS = 100;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type RecentRecordEventKind =
  | 'automatic-save'
  | 'confirmed-save'
  | 'duplicate-copy'
  | 'duplicate-preserved'
  | 'existing-bookmark-move'
  | 'pending-fallback'
  | 'retry-failed'
  | 'retry-automatic'
  | 'retry-confirmed'
  | 'classification-correction'
  | 'undo';

export interface RecentRecordFolder {
  id: string;
  path: string;
}

export interface RecentRecordEvent {
  kind: RecentRecordEventKind;
  timestamp: string;
  fromFolder?: RecentRecordFolder;
  toFolder?: RecentRecordFolder | null;
}

export interface RecentRecord {
  id: string;
  operationId: string;
  title: string;
  url: string;
  timestamp: string;
  updatedAt: string;
  classificationPath: RecentRecordEvent[];
  originalFolder?: RecentRecordFolder;
  finalFolder: RecentRecordFolder | null;
  undoState: 'available' | 'unavailable' | 'undone';
}

export function normalizeRecentRecords(value: unknown, now: string): RecentRecord[] {
  if (!Array.isArray(value)) return [];
  const cutoff = Date.parse(now) - RETENTION_MS;
  return value
    .flatMap(parseRecentRecord)
    .filter(({ timestamp }) => {
      const parsed = Date.parse(timestamp);
      return Number.isFinite(parsed) && parsed >= cutoff;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_RECENT_RECORDS);
}

export function updateRecentRecords(
  records: RecentRecord[],
  previous: OperationState | undefined,
  operation: OperationState,
  recordedAt: string,
): RecentRecord[] {
  const event = recentRecordEvent(previous, operation, recordedAt);
  if (!event) return normalizeRecentRecords(records, recordedAt);

  const existing = records.find(({ operationId }) => operationId === operation.id);
  const fromFolder = event.fromFolder;
  const next: RecentRecord = {
    id: operation.id,
    operationId: operation.id,
    title: operation.page.title,
    url: operation.page.url,
    timestamp: existing?.timestamp ?? operation.createdAt,
    updatedAt: recordedAt,
    classificationPath: [...(existing?.classificationPath ?? []), event],
    ...(existing?.originalFolder
      ? { originalFolder: existing.originalFolder }
      : fromFolder
        ? { originalFolder: fromFolder }
        : {}),
    finalFolder: event.toFolder === undefined
      ? existing?.finalFolder ?? folderFromOperation(operation)
      : event.toFolder,
    undoState: undoStateFor(operation),
  };
  return normalizeRecentRecords(
    [next, ...records.filter(({ operationId }) => operationId !== operation.id)],
    recordedAt,
  );
}

export function deleteRecentRecord(records: RecentRecord[], id: string): RecentRecord[] {
  return records.filter((record) => record.id !== id);
}

export function clearRecentRecords(): RecentRecord[] {
  return [];
}

export function buildRecentRecordsExport(
  records: RecentRecord[],
  acknowledgedSensitiveFields: boolean,
  generatedAt: string,
): string {
  if (!acknowledgedSensitiveFields) {
    throw new Error('RECENT_RECORD_EXPORT_ACK_REQUIRED');
  }
  return JSON.stringify({
    generatedAt,
    includes: ['titles', 'URLs', 'folder paths'],
    records,
  }, null, 2);
}

function recentRecordEvent(
  previous: OperationState | undefined,
  operation: OperationState,
  timestamp: string,
): RecentRecordEvent | undefined {
  if (operation.status === 'pending' && previous?.status !== 'pending') {
    return {
      kind: operation.retryingPending ? 'retry-failed' : 'pending-fallback',
      timestamp,
      toFolder: folderFromOperation(operation),
    };
  }
  if (operation.status === 'duplicate-preserved' && previous?.status !== 'duplicate-preserved') {
    const duplicate = operation.duplicateBookmarks.length === 1
      ? operation.duplicateBookmarks[0]
      : undefined;
    return {
      kind: 'duplicate-preserved',
      timestamp,
      toFolder: duplicate
        ? { id: duplicate.parentId, path: duplicate.folderPath }
        : null,
    };
  }
  if (operation.status === 'saved') {
    const destination = folderFromOperation(operation);
    if (previous?.status === 'saved') {
      const source = folderFromOperation(previous);
      if (source?.id !== destination?.id) {
        return {
          kind: 'classification-correction',
          timestamp,
          ...(source ? { fromFolder: source } : {}),
          toFolder: destination,
        };
      }
      return undefined;
    }
    if (previous?.status === 'moving-pending') {
      const source = folderFromOperation(previous);
      return {
        kind: operation.saveMethod === 'automatic' ? 'retry-automatic' : 'retry-confirmed',
        timestamp,
        ...(source ? { fromFolder: source } : {}),
        toFolder: destination,
      };
    }
    if (operation.saveMethod === 'existing-move') {
      const selected = operation.duplicateBookmarks.find(
        ({ bookmarkId }) => bookmarkId === operation.selectedExistingBookmarkId,
      );
      return {
        kind: 'existing-bookmark-move',
        timestamp,
        ...(selected
          ? { fromFolder: { id: selected.parentId, path: selected.folderPath } }
          : {}),
        toFolder: destination,
      };
    }
    const kind: RecentRecordEventKind = operation.saveMethod === 'automatic'
      ? 'automatic-save'
      : operation.saveMethod === 'duplicate-copy'
        ? 'duplicate-copy'
        : 'confirmed-save';
    return { kind, timestamp, toFolder: destination };
  }
  if (operation.status === 'undone' && previous?.status !== 'undone') {
    const source = folderFromOperation(previous ?? operation);
    const restored = operation.mutation?.kind === 'moved-existing'
      ? originalFolderForMovedBookmark(operation)
      : null;
    return {
      kind: 'undo',
      timestamp,
      ...(source ? { fromFolder: source } : {}),
      toFolder: restored,
    };
  }
  return undefined;
}

function folderFromOperation(operation: OperationState): RecentRecordFolder | null {
  if (!operation.finalFolderId || !operation.finalFolderPath) return null;
  return { id: operation.finalFolderId, path: operation.finalFolderPath };
}

function originalFolderForMovedBookmark(
  operation: OperationState,
): RecentRecordFolder | null {
  if (operation.mutation?.kind !== 'moved-existing') return null;
  const selected = operation.duplicateBookmarks.find(
    ({ bookmarkId }) => bookmarkId === operation.mutation?.bookmarkId,
  );
  return selected
    ? { id: operation.mutation.originalParentId, path: selected.folderPath }
    : null;
}

function undoStateFor(operation: OperationState): RecentRecord['undoState'] {
  if (operation.status === 'undone') return 'undone';
  return operation.status === 'saved' && operation.mutation ? 'available' : 'unavailable';
}

function parseRecentRecord(value: unknown): RecentRecord[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.id !== 'string' ||
    typeof value.operationId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.classificationPath) ||
    (value.undoState !== 'available' &&
      value.undoState !== 'unavailable' &&
      value.undoState !== 'undone')
  ) {
    return [];
  }
  const classificationPath = value.classificationPath.flatMap(parseRecentRecordEvent);
  if (classificationPath.length !== value.classificationPath.length) return [];
  const finalFolder = value.finalFolder === null ? null : parseFolder(value.finalFolder);
  if (value.finalFolder !== null && !finalFolder) return [];
  const originalFolder = parseFolder(value.originalFolder);
  return [{
    id: value.id,
    operationId: value.operationId,
    title: value.title,
    url: value.url,
    timestamp: value.timestamp,
    updatedAt: value.updatedAt,
    classificationPath,
    ...(originalFolder ? { originalFolder } : {}),
    finalFolder: finalFolder ?? null,
    undoState: value.undoState,
  }];
}

function parseRecentRecordEvent(value: unknown): RecentRecordEvent[] {
  if (!isRecord(value) || !isEventKind(value.kind) || typeof value.timestamp !== 'string') {
    return [];
  }
  const fromFolder = parseFolder(value.fromFolder);
  const toFolder = value.toFolder === null ? null : parseFolder(value.toFolder);
  return [{
    kind: value.kind,
    timestamp: value.timestamp,
    ...(fromFolder ? { fromFolder } : {}),
    ...(value.toFolder === null
      ? { toFolder: null }
      : toFolder
        ? { toFolder }
        : {}),
  }];
}

function parseFolder(value: unknown): RecentRecordFolder | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') {
    return undefined;
  }
  return { id: value.id, path: value.path };
}

function isEventKind(value: unknown): value is RecentRecordEventKind {
  return typeof value === 'string' && [
    'automatic-save',
    'confirmed-save',
    'duplicate-copy',
    'duplicate-preserved',
    'existing-bookmark-move',
    'pending-fallback',
    'retry-failed',
    'retry-automatic',
    'retry-confirmed',
    'classification-correction',
    'undo',
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
