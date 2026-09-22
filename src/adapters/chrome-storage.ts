import { browser } from 'wxt/browser';

import {
  normalizeRecentRecords,
  updateRecentRecords,
  type RecentRecord,
} from '../application/recent-records';
import type {
  OperationState,
  Settings,
  SmartSaveStoragePort,
  StoredFolderExample,
} from '../application/types';

const SETTINGS_KEY = 'smartSaveSettings';
const OPERATIONS_KEY = 'smartSaveOperations';
const CORRECTIONS_KEY = 'classificationCorrections';
const FOLDER_EXAMPLES_KEY = 'folderExamples';
const RECENT_RECORDS_KEY = 'smartSaveRecentRecords';

const DEFAULT_SETTINGS: Settings = {
  consent: 'unknown',
  excludedFolderIds: [],
};

export class ChromeStoragePort implements SmartSaveStoragePort {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async getSettings(): Promise<Settings> {
    const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (!isRecord(stored)) return { ...DEFAULT_SETTINGS };
    const consent =
      stored.consent === 'granted' || stored.consent === 'declined' ? stored.consent : 'unknown';
    return {
      consent,
      excludedFolderIds: Array.isArray(stored.excludedFolderIds)
        ? stored.excludedFolderIds.filter((value): value is string => typeof value === 'string')
        : [],
      ...(typeof stored.apiKey === 'string' && stored.apiKey ? { apiKey: stored.apiKey } : {}),
      ...(typeof stored.pendingFolderId === 'string' && stored.pendingFolderId
        ? { pendingFolderId: stored.pendingFolderId }
        : {}),
      ...(typeof stored.pendingFolderCreationToken === 'string' && stored.pendingFolderCreationToken
        ? { pendingFolderCreationToken: stored.pendingFolderCreationToken }
        : {}),
    };
  }

  async saveSettings(settings: Settings): Promise<void> {
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async getOperation(id: string): Promise<OperationState | undefined> {
    const operations = await this.getOperations();
    return operations[id];
  }

  async getActiveOperation(tabId: number, url: string): Promise<OperationState | undefined> {
    return Object.values(await this.getOperations()).find(
      (operation) =>
        operation.tabId === tabId &&
        operation.page.url === url &&
        operation.status !== 'saved' &&
        operation.status !== 'undone' &&
        operation.status !== 'duplicate-preserved' &&
        operation.status !== 'disabled' &&
        operation.status !== 'capture-failed',
    );
  }

  async getInFlightOperations(): Promise<OperationState[]> {
    return Object.values(await this.getOperations()).filter(
      (operation) =>
        operation.status === 'classifying' ||
        operation.status === 'saving-pending' ||
        operation.status === 'creating-bookmark' ||
        operation.status === 'moving-pending',
    );
  }

  async saveOperation(operation: OperationState): Promise<void> {
    let previous: OperationState | undefined;
    await navigator.locks.request('smart-favorites-operations', async () => {
      const operations = await this.getOperations();
      previous = operations[operation.id];
      operations[operation.id] = operation;
      await browser.storage.session.set({ [OPERATIONS_KEY]: operations });
    });
    await navigator.locks.request('smart-favorites-recent-records', async () => {
      const recordedAt = this.now();
      const records = await this.readRecentRecords(recordedAt);
      await browser.storage.local.set({
        [RECENT_RECORDS_KEY]: updateRecentRecords(
          records,
          previous,
          operation,
          recordedAt,
        ),
      });
    });
  }

  async getRecentRecords(): Promise<RecentRecord[]> {
    const now = this.now();
    const records = await this.readRecentRecords(now);
    await browser.storage.local.set({ [RECENT_RECORDS_KEY]: records });
    return records;
  }

  async deleteRecentRecord(id: string): Promise<void> {
    await navigator.locks.request('smart-favorites-recent-records', async () => {
      const records = await this.readRecentRecords(this.now());
      await browser.storage.local.set({
        [RECENT_RECORDS_KEY]: records.filter((record) => record.id !== id),
      });
    });
  }

  async clearRecentRecords(): Promise<void> {
    await navigator.locks.request('smart-favorites-recent-records', async () => {
      await browser.storage.local.set({ [RECENT_RECORDS_KEY]: [] });
    });
  }

  async getFolderExamples(): Promise<StoredFolderExample[]> {
    const stored = await browser.storage.local.get([FOLDER_EXAMPLES_KEY, CORRECTIONS_KEY]);
    const examples = Array.isArray(stored[FOLDER_EXAMPLES_KEY])
      ? stored[FOLDER_EXAMPLES_KEY].flatMap(parseStoredFolderExample)
      : [];
    const legacyCorrections = Array.isArray(stored[CORRECTIONS_KEY])
      ? stored[CORRECTIONS_KEY].flatMap((value) => {
          const correction = parseFolderExampleFields(value);
          return correction
            ? [{ ...correction, source: 'classification-correction' as const }]
            : [];
        })
      : [];
    const byIdentity = new Map<string, StoredFolderExample>();
    for (const example of [...legacyCorrections, ...examples]) {
      byIdentity.set(folderExampleIdentity(example), example);
    }
    return [...byIdentity.values()];
  }

  async saveFolderExample(example: StoredFolderExample): Promise<void> {
    await navigator.locks.request('smart-favorites-folder-examples', async () => {
      const stored = await this.getFolderExamples();
      const identity = folderExampleIdentity(example);
      if (stored.some((candidate) => folderExampleIdentity(candidate) === identity)) return;
      await browser.storage.local.set({
        [FOLDER_EXAMPLES_KEY]: [...stored, example],
      });
    });
  }

  async runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    return navigator.locks.request(`smart-favorites-operation:${id}`, task);
  }

  private async getOperations(): Promise<Record<string, OperationState>> {
    const stored = (await browser.storage.session.get(OPERATIONS_KEY))[OPERATIONS_KEY];
    return isRecord(stored) ? (stored as Record<string, OperationState>) : {};
  }

  private async readRecentRecords(now: string): Promise<RecentRecord[]> {
    const stored = (await browser.storage.local.get(RECENT_RECORDS_KEY))[RECENT_RECORDS_KEY];
    return normalizeRecentRecords(stored, now);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredFolderExample(value: unknown): StoredFolderExample[] {
  if (!isRecord(value)) return [];
  if (
    value.source !== 'classification-correction' &&
    value.source !== 'confirmed-save'
  ) {
    return [];
  }
  const fields = parseFolderExampleFields(value);
  return fields ? [{ ...fields, source: value.source }] : [];
}

function parseFolderExampleFields(
  value: unknown,
): Omit<StoredFolderExample, 'source'> | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.operationId !== 'string' ||
    typeof value.bookmarkId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.domain !== 'string' ||
    typeof value.folderId !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return undefined;
  }
  return {
    operationId: value.operationId,
    bookmarkId: value.bookmarkId,
    title: value.title,
    domain: value.domain,
    folderId: value.folderId,
    createdAt: value.createdAt,
  };
}

function folderExampleIdentity(example: StoredFolderExample): string {
  return `${example.source}:${example.operationId}:${example.folderId}`;
}
