import { describe, expect, it } from 'vitest';

import {
  buildRecentRecordsExport,
  clearRecentRecords,
  deleteRecentRecord,
  normalizeRecentRecords,
  updateRecentRecords,
  type RecentRecord,
} from './recent-records';
import type { OperationState } from './types';

const now = '2026-09-22T08:00:00.000Z';

describe('Recent Records', () => {
  it('keeps only the newest 100 local records from the last 30 days', () => {
    const records = Array.from({ length: 105 }, (_, index) => {
      const timestamp = new Date(Date.parse(now) - index * 60_000).toISOString();
      return record(`operation-${index}`, timestamp);
    });
    records.push(record('expired', '2026-08-22T07:59:59.000Z'));

    const retained = normalizeRecentRecords(records, now);

    expect(retained).toHaveLength(100);
    expect(retained[0]?.operationId).toBe('operation-0');
    expect(retained.at(-1)?.operationId).toBe('operation-99');
    expect(retained.some(({ operationId }) => operationId === 'expired')).toBe(false);
  });

  it('strictly redacts unrecognized stored fields and supports deletion and clearing', () => {
    const unsafe = {
      ...record('operation-safe', now),
      pageBody: 'private page body',
      apiKey: 'jev-secret',
      authorization: 'Bearer secret',
      jevRequest: { page: { visibleText: 'private' } },
      jevResponse: { raw: 'private' },
    };

    const normalized = normalizeRecentRecords([unsafe], now);
    const serialized = JSON.stringify(normalized);

    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('secret');
    expect(deleteRecentRecord(normalized, 'operation-safe')).toEqual([]);
    expect(clearRecentRecords()).toEqual([]);
  });

  it('redacts credentials and secret-like values embedded in allowed title and URL fields', () => {
    const unsafeOperation = operation({
      page: {
        ...operation({}).page,
        title: 'Authorization: Bearer title-secret api_key=title-key',
        url: 'https://user:password@example.com/page?api_key=url-key&token=url-token&safe=yes#private',
      },
      status: 'saved',
      finalFolderId: 'folder-a',
      finalFolderPath: '书签栏 / A',
      saveMethod: 'automatic',
    });

    const records = updateRecentRecords(
      [],
      operation({ status: 'creating-bookmark' }),
      unsafeOperation,
      now,
    );
    const serialized = JSON.stringify(records);

    expect(serialized).not.toContain('title-secret');
    expect(serialized).not.toContain('title-key');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('url-key');
    expect(serialized).not.toContain('url-token');
    expect(serialized).not.toContain('private');
    expect(records[0]?.url).toContain('safe=yes');
  });

  it('projects fallback, retry, correction, and Undo into one coherent record', () => {
    const pending = operation({
      status: 'pending',
      finalFolderId: 'pending-folder',
      finalFolderPath: '待分类',
      finalBookmarkId: 'bookmark-1',
      saveMethod: 'pending',
      mutation: {
        kind: 'created',
        bookmarkId: 'bookmark-1',
        title: 'Example',
        url: 'https://example.com',
        currentParentId: 'pending-folder',
      },
    });
    const retried = operation({
      ...pending,
      status: 'saved',
      finalFolderId: 'folder-a',
      finalFolderPath: '书签栏 / A',
      saveMethod: 'automatic',
      mutation: { ...pending.mutation!, currentParentId: 'folder-a' },
    });
    const corrected = operation({
      ...retried,
      finalFolderId: 'folder-b',
      finalFolderPath: '书签栏 / B',
      mutation: { ...retried.mutation!, currentParentId: 'folder-b' },
    });
    const undone = operation({ ...corrected, status: 'undone' });

    let records = updateRecentRecords([], operation({ status: 'saving-pending' }), pending, now);
    records = updateRecentRecords(records, operation({ ...pending, status: 'moving-pending' }), retried, '2026-09-22T08:01:00.000Z');
    records = updateRecentRecords(records, retried, corrected, '2026-09-22T08:02:00.000Z');
    records = updateRecentRecords(records, corrected, undone, '2026-09-22T08:03:00.000Z');

    expect(records).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        title: 'Example',
        url: 'https://example.com',
        timestamp: '2026-09-22T07:59:00.000Z',
        originalFolder: { id: 'pending-folder', path: '待分类' },
        finalFolder: null,
        undoState: 'undone',
        classificationPath: [
          expect.objectContaining({ kind: 'pending-fallback' }),
          expect.objectContaining({ kind: 'retry-automatic' }),
          expect.objectContaining({ kind: 'classification-correction' }),
          expect.objectContaining({ kind: 'undo' }),
        ],
      }),
    ]);
  });

  it('distinguishes a failed retry from the initial Pending Folder fallback', () => {
    const initialPending = operation({
      status: 'pending',
      finalFolderId: 'pending-folder',
      finalFolderPath: '待分类',
      saveMethod: 'pending',
    });
    const retrying = operation({
      ...initialPending,
      status: 'classifying',
      retryingPending: true,
    });
    const failedAgain = operation({
      ...retrying,
      status: 'pending',
    });

    let records = updateRecentRecords(
      [],
      operation({ status: 'saving-pending' }),
      initialPending,
      now,
    );
    records = updateRecentRecords(
      records,
      retrying,
      failedAgain,
      '2026-09-22T08:01:00.000Z',
    );

    expect(records[0]?.classificationPath.map(({ kind }) => kind)).toEqual([
      'pending-fallback',
      'retry-failed',
    ]);
  });

  it('keeps every Existing Bookmark location when multiple duplicates are preserved', () => {
    const duplicatePreserved = operation({
      status: 'duplicate-preserved',
      duplicateBookmarks: [
        {
          bookmarkId: 'bookmark-a',
          parentId: 'folder-a',
          index: 0,
          title: 'Example',
          url: 'https://example.com',
          folderPath: '书签栏 / A',
        },
        {
          bookmarkId: 'bookmark-b',
          parentId: 'folder-b',
          index: 0,
          title: 'Example',
          url: 'https://example.com',
          folderPath: '书签栏 / B',
        },
      ],
    });

    const records = updateRecentRecords(
      [],
      operation({ status: 'duplicate-warning' }),
      duplicatePreserved,
      now,
    );

    expect(records[0]).toMatchObject({
      finalFolder: { id: 'folder-a', path: '书签栏 / A' },
      preservedFolders: [
        { id: 'folder-a', path: '书签栏 / A' },
        { id: 'folder-b', path: '书签栏 / B' },
      ],
    });
  });

  it('requires an explicit sensitive-field acknowledgement before local JSON export', () => {
    const records = [record('operation-export', now)];

    expect(() => buildRecentRecordsExport(records, false, now)).toThrow(
      'RECENT_RECORD_EXPORT_ACK_REQUIRED',
    );
    const report = JSON.parse(buildRecentRecordsExport(records, true, now)) as {
      generatedAt: string;
      includes: string[];
      records: RecentRecord[];
    };
    expect(report).toMatchObject({
      generatedAt: now,
      includes: ['titles', 'URLs', 'folder paths'],
      records: [{ operationId: 'operation-export' }],
    });
  });
});

function record(operationId: string, timestamp: string): RecentRecord {
  return {
    id: operationId,
    operationId,
    title: `Title ${operationId}`,
    url: `https://example.com/${operationId}`,
    timestamp,
    updatedAt: timestamp,
    classificationPath: [{ kind: 'automatic-save', timestamp }],
    finalFolder: { id: 'folder-a', path: '书签栏 / A' },
    undoState: 'available',
  };
}

function operation(overrides: Partial<OperationState>): OperationState {
  return {
    id: 'operation-1',
    tabId: 42,
    status: 'classifying',
    page: {
      title: 'Example',
      url: 'https://example.com',
      domain: 'example.com',
      description: 'must not enter records',
      h1: 'must not enter records',
      visibleText: 'private page body',
      classificationAllowed: true,
    },
    folders: [],
    candidates: [],
    duplicateBookmarks: [],
    createdAt: '2026-09-22T07:59:00.000Z',
    ...overrides,
  };
}
