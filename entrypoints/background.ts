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
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    handleCommand(message as ExtensionCommand)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorKey: 'genericError' } satisfies ExtensionResponse));
    return true;
  });
});

async function handleCommand(command: ExtensionCommand): Promise<ExtensionResponse> {
  const storage = new ChromeStoragePort();

  try {
    switch (command.type) {
      case 'START_SMART_SAVE':
        return success(await createSmartSaveService().start({ tabId: await getActiveTabId() }));
      case 'DECIDE_CONSENT':
        return success(await createSmartSaveService().decideConsent(command));
      case 'CONFIRM_FOLDER':
        return success(await createSmartSaveService().confirm(command));
      case 'GET_SETTINGS':
        return success(settingsView(await storage.getSettings()));
      case 'SAVE_API_KEY': {
        const apiKey = command.apiKey.trim();
        if (!apiKey) return { ok: false, errorKey: 'emptyKey' };
        const settings = await storage.getSettings();
        await storage.saveSettings({ ...settings, apiKey });
        return success(settingsView({ ...settings, apiKey }));
      }
      case 'TEST_API_KEY': {
        const settings = await storage.getSettings();
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
        };
        await storage.saveSettings(withoutKey);
        return success(settingsView(withoutKey));
      }
      case 'SET_CONSENT': {
        const settings = await storage.getSettings();
        const updated = {
          ...settings,
          consent: command.granted ? ('granted' as const) : ('declined' as const),
        };
        await storage.saveSettings(updated);
        return success(settingsView(updated));
      }
    }
  } catch (error) {
    if (error instanceof JevClientError && error.code === 'invalid-key') {
      return { ok: false, errorKey: 'keyInvalid' };
    }
    return { ok: false, errorKey: 'genericError' };
  }
}

function settingsView(settings: Awaited<ReturnType<ChromeStoragePort['getSettings']>>): SettingsView {
  const apiKey = settings.apiKey ?? '';
  return {
    consent: settings.consent,
    hasApiKey: Boolean(apiKey),
    maskedApiKey: apiKey ? `••••${apiKey.slice(-4)}` : '',
  };
}

function success(data: CommandData): ExtensionResponse {
  return { ok: true, data };
}
