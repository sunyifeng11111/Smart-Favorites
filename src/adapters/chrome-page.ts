import { browser } from 'wxt/browser';

import type { CapturedPage, PagePort } from '../application/types';
import { httpDomain } from '../shared/url';
import { pageCaptureScript } from './page-capture';

export class ChromePagePort implements PagePort {
  async capture(tabId: number): Promise<CapturedPage> {
    const before = await browser.tabs.get(tabId);
    const url = before.url ?? '';
    const title = before.title?.trim() || url;

    if (before.incognito) return restrictedPage(title, url, 'incognito');
    if (!/^https?:\/\//i.test(url)) return restrictedPage(title, url, 'unsupported-scheme');

    try {
      const [injection] = await browser.scripting.executeScript({
        target: { tabId },
        func: pageCaptureScript,
        args: [url],
      });
      const after = await browser.tabs.get(tabId);
      if (after.url !== url) throw new Error('Page navigated before capture completed');
      if (injection?.result) return injection.result;
    } catch {
      // Restricted HTTP(S) pages deliberately fall back to the signals Chrome exposes.
    }

    return {
      title,
      url,
      domain: '',
      description: '',
      h1: '',
      visibleText: '',
      classificationAllowed: true,
    };
  }
}

export async function getActiveTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error('No active tab');
  return tab.id;
}

function restrictedPage(
  title: string,
  url: string,
  restrictionReason: 'incognito' | 'unsupported-scheme',
): CapturedPage {
  return {
    title,
    url,
    domain: httpDomain(url) ?? '',
    description: '',
    h1: '',
    visibleText: '',
    classificationAllowed: false,
    restrictionReason,
  };
}
