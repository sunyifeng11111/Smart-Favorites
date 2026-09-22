import { browser, type Browser } from 'wxt/browser';

import type { CapturedPage, PagePort } from '../application/types';
import { httpDomain } from '../shared/url';
import { pageCaptureScript } from './page-capture';

export class ChromePagePort implements PagePort {
  async inspect(tabId: number): Promise<CapturedPage> {
    return inspectTab(await browser.tabs.get(tabId));
  }

  async capture(tabId: number, expectedUrl: string): Promise<CapturedPage> {
    const before = await browser.tabs.get(tabId);
    const inspected = inspectTab(before);
    const { url } = inspected;
    if (url !== expectedUrl) throw new Error('Page changed before capture completed');
    if (!inspected.classificationAllowed) return inspected;

    let captured: CapturedPage | undefined;
    try {
      const [injection] = await browser.scripting.executeScript({
        target: { tabId },
        func: pageCaptureScript,
        args: [url],
      });
      captured = injection?.result;
    } catch {
      // Restricted HTTP(S) pages deliberately fall back to the signals Chrome exposes.
    }

    const after = await browser.tabs.get(tabId);
    if (after.url !== url) throw new Error('Page changed before capture completed');
    if (captured) return captured;

    return {
      ...inspected,
      domain: '',
    };
  }
}

type BrowserTab = Browser.tabs.Tab;

function inspectTab(tab: BrowserTab): CapturedPage {
  const url = tab.url ?? '';
  const title = tab.title?.trim() || url;
  if (tab.incognito) return restrictedPage(title, url, 'incognito');
  if (!/^https?:\/\//i.test(url)) return restrictedPage(title, url, 'unsupported-scheme');
  return {
    title,
    url,
    domain: httpDomain(url) ?? '',
    description: '',
    h1: '',
    visibleText: '',
    classificationAllowed: true,
  };
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
