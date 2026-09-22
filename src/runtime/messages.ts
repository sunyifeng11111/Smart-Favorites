import type { OperationState } from '../application/types';

export type ExtensionCommand =
  | { type: 'START_SMART_SAVE' }
  | { type: 'DECIDE_CONSENT'; operationId: string; granted: boolean }
  | { type: 'CONFIRM_FOLDER'; operationId: string; folderId: string }
  | {
      type: 'RESOLVE_DUPLICATE';
      operationId: string;
      action: 'preserve' | 'create-copy' | 'reclassify';
      bookmarkId?: string;
    }
  | { type: 'CHANGE_DESTINATION'; operationId: string; folderId: string }
  | { type: 'UNDO_SMART_SAVE'; operationId: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_API_KEY'; apiKey: string }
  | { type: 'TEST_API_KEY'; apiKey?: string }
  | { type: 'CLEAR_API_KEY' }
  | { type: 'SET_CONSENT'; granted: boolean };

export interface SettingsView {
  consent: 'unknown' | 'granted' | 'declined';
  hasApiKey: boolean;
  maskedApiKey: string;
}

export type CommandData = OperationState | SettingsView | { message: 'ok' };

export type ExtensionResponse =
  | { ok: true; data: CommandData }
  | {
      ok: false;
      errorKey: 'genericError' | 'keyInvalid' | 'emptyKey' | 'consentRequiredForTest';
    };
