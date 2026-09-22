import { browser } from 'wxt/browser';

import { getActiveTabId } from '../src/adapters/chrome-page';
import { ChromeStoragePort } from '../src/adapters/chrome-storage';
import { HttpJevClient, JevClientError } from '../src/adapters/jev-client';
import { createSmartSaveService } from '../src/runtime/create-service';
import type {
  CommandData,
  ExtensionCommand,
  ExtensionResponse,
  SettingsView,
} from '../src/runtime/messages';

export default defineBackground(() => {
  void createSmartSaveService().resumeInFlightOperations().catch(() => undefined);
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    handleCommand(message as ExtensionCommand)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorKey: 'genericError' } satisfies ExtensionResponse));
    return true;
  });
});

async function handleCommand(command: ExtensionCommand): Promise<ExtensionResponse> {
  const storage = new ChromeStoragePort();
  const service = createSmartSaveService();

  try {
    switch (command.type) {
      case 'START_SMART_SAVE':
        return success(await service.start({ tabId: await getActiveTabId() }));
      case 'RETRY_PENDING':
        return success(await service.retryPending(command));
      case 'DECIDE_CONSENT':
        return success(await service.decideConsent(command));
      case 'CONFIRM_FOLDER':
        return success(await service.confirm(command));
      case 'RESOLVE_DUPLICATE':
        return success(await service.resolveDuplicate(command));
      case 'CHANGE_DESTINATION':
        return success(await service.changeDestination(command));
      case 'UNDO_SMART_SAVE':
        return success(await service.undo(command));
      case 'GET_SETTINGS':
        return success(await settingsView(await storage.getSettings(), service));
      case 'SAVE_API_KEY': {
        const apiKey = command.apiKey.trim();
        if (!apiKey) return { ok: false, errorKey: 'emptyKey' };
        const settings = await storage.getSettings();
        await storage.saveSettings({ ...settings, apiKey });
        return success(await settingsView({ ...settings, apiKey }, service));
      }
      case 'TEST_API_KEY': {
        const settings = await storage.getSettings();
        if (settings.consent !== 'granted') {
          return { ok: false, errorKey: 'consentRequiredForTest' };
        }
        const apiKey = command.apiKey?.trim() || settings.apiKey;
        if (!apiKey) return { ok: false, errorKey: 'emptyKey' };
        await new HttpJevClient().testKey(apiKey);
        return success({ message: 'ok' });
      }
      case 'CLEAR_API_KEY': {
        const settings = await storage.getSettings();
        const withoutKey = {
          consent: settings.consent,
          excludedFolderIds: settings.excludedFolderIds,
          ...(settings.pendingFolderId ? { pendingFolderId: settings.pendingFolderId } : {}),
          ...(settings.pendingFolderCreationToken
            ? { pendingFolderCreationToken: settings.pendingFolderCreationToken }
            : {}),
        };
        await storage.saveSettings(withoutKey);
        return success(await settingsView(withoutKey, service));
      }
      case 'SET_CONSENT': {
        const settings = await storage.getSettings();
        const updated = {
          ...settings,
          consent: command.granted ? ('granted' as const) : ('declined' as const),
        };
        await storage.saveSettings(updated);
        return success(await settingsView(updated, service));
      }
      case 'SET_FOLDER_EXCLUSION': {
        const folderTree = await service.setFolderExcluded(command);
        return success(await settingsView(await storage.getSettings(), service, folderTree));
      }
      case 'DELETE_RECENT_RECORD': {
        await storage.deleteRecentRecord(command.recordId);
        return success(await settingsView(await storage.getSettings(), service));
      }
      case 'CLEAR_RECENT_RECORDS': {
        await storage.clearRecentRecords();
        return success(await settingsView(await storage.getSettings(), service));
      }
    }
  } catch (error) {
    if (error instanceof JevClientError && error.code === 'invalid-key') {
      return { ok: false, errorKey: 'keyInvalid' };
    }
    return { ok: false, errorKey: 'genericError' };
  }
}

async function settingsView(
  settings: Awaited<ReturnType<ChromeStoragePort['getSettings']>>,
  service: ReturnType<typeof createSmartSaveService>,
  knownFolderTree?: SettingsView['folderTree'],
): Promise<SettingsView> {
  const apiKey = settings.apiKey ?? '';
  const [folderTree, recentRecords] = await Promise.all([
    knownFolderTree ?? service.getFolderExclusionTree(),
    new ChromeStoragePort().getRecentRecords(),
  ]);
  return {
    consent: settings.consent,
    hasApiKey: Boolean(apiKey),
    maskedApiKey: apiKey ? `••••${apiKey.slice(-4)}` : '',
    folderTree,
    recentRecords,
  };
}

function success(data: CommandData): ExtensionResponse {
  return { ok: true, data };
}
