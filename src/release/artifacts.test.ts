import { describe, expect, it } from 'vitest';

import {
  expectedChromeZipName,
  verifyProductionManifest,
} from './artifacts';

describe('private-beta artifacts', () => {
  it('accepts exactly the approved MV3 permissions and JEV host access', () => {
    expect(() => verifyProductionManifest(validManifest())).not.toThrow();
  });

  it('rejects extra permissions, host access, or missing browser wiring', () => {
    expect(() => verifyProductionManifest(validManifest({
      permissions: ['bookmarks', 'storage', 'activeTab', 'scripting', 'tabs'],
    }))).toThrow('permissions');

    expect(() => verifyProductionManifest(validManifest({
      host_permissions: ['<all_urls>'],
    }))).toThrow('host access');

    expect(() => verifyProductionManifest(validManifest({
      background: undefined,
      action: undefined,
      options_ui: undefined,
    }))).toThrow('browser wiring');
  });

  it('derives the WXT versioned Chrome package name', () => {
    expect(expectedChromeZipName('smart-favorites', '0.1.0'))
      .toBe('smart-favorites-0.1.0-chrome.zip');
  });
});

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    permissions: ['bookmarks', 'storage', 'activeTab', 'scripting'],
    host_permissions: ['https://api.typesafe.ai/*'],
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html' },
    options_ui: { page: 'options.html' },
    ...overrides,
  };
}
