import { browser } from 'wxt/browser';

import type {
  ClassificationCorrection,
  OperationState,
  Settings,
  SmartSaveStoragePort,
} from '../application/types';

const SETTINGS_KEY = 'smartSaveSettings';
const OPERATIONS_KEY = 'smartSaveOperations';
const CORRECTIONS_KEY = 'classificationCorrections';

const DEFAULT_SETTINGS: Settings = {
  consent: 'unknown',
  excludedFolderIds: [],
};

export class ChromeStoragePort implements SmartSaveStoragePort {
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
    };
  }

  async saveSettings(settings: Settings): Promise<void> {
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async getOperation(id: string): Promise<OperationState | undefined> {
    const operations = await this.getOperations();
    return operations[id];
  }

  async saveOperation(operation: OperationState): Promise<void> {
    const operations = await this.getOperations();
    operations[operation.id] = operation;
    await browser.storage.session.set({ [OPERATIONS_KEY]: operations });
  }

  async saveClassificationCorrection(correction: ClassificationCorrection): Promise<void> {
    const stored = (await browser.storage.local.get(CORRECTIONS_KEY))[CORRECTIONS_KEY];
    const corrections = Array.isArray(stored) ? stored : [];
    await browser.storage.local.set({
      [CORRECTIONS_KEY]: [...corrections, correction],
    });
  }

  async runOperationExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    return navigator.locks.request(`smart-favorites-operation:${id}`, task);
  }

  private async getOperations(): Promise<Record<string, OperationState>> {
    const stored = (await browser.storage.session.get(OPERATIONS_KEY))[OPERATIONS_KEY];
    return isRecord(stored) ? (stored as Record<string, OperationState>) : {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
