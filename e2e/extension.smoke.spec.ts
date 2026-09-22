import { expect, test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { verifyProductionManifest } from '../src/release/artifacts';

interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
}

const extensionPath = resolve('.output/chrome-mv3');
const test = base.extend<ExtensionFixtures>({
  context: async ({ browserName }, use) => {
    if (browserName !== 'chromium') throw new Error('Extension smoke tests require Chromium');
    const userDataDir = await mkdtemp(join(tmpdir(), 'smart-favorites-playwright-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  serviceWorker: async ({ context }, use) => {
    const existing = context.serviceWorkers()[0];
    await use(existing ?? await context.waitForEvent('serviceworker'));
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

test('production manifest and settings wiring are verifiable in Chromium', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const manifest: unknown = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  verifyProductionManifest(manifest);
  expect(manifest).toMatchObject({
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    options_ui: {
      open_in_tab: true,
      page: 'options.html',
    },
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const keyInput = page.getByLabel('JEV API 密钥');
  const editableKeyBox = await keyInput.boundingBox();
  await keyInput.fill('browser-smoke-secret');
  await page.getByRole('button', { name: '保存密钥' }).click();
  await expect(page.getByText('密钥已保存')).toBeVisible();
  await expect(keyInput).toHaveValue('••••cret');
  await expect(keyInput).toHaveAttribute('readonly');
  const lockedKeyBox = await keyInput.boundingBox();
  expect(lockedKeyBox?.width).toBe(editableKeyBox?.width);
  expect(lockedKeyBox?.height).toBe(editableKeyBox?.height);

  await page.getByRole('button', { name: '修改密钥' }).click();
  await expect(page.getByLabel('JEV API 密钥')).toBeEditable();
  await expect(page.getByLabel('JEV API 密钥')).toHaveValue('');
  await page.getByRole('button', { name: '取消修改' }).click();

  await page.reload();
  await expect(page.getByText('已保存：••••cret')).toBeVisible();
});

test('settings verifies a saved JEV key in Chromium', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  await seedGrantedSettings(serviceWorker);
  await serviceWorker.evaluate(() => {
    const scope = globalThis;
    scope.fetch = async function receiverSensitiveFetch(this: typeof globalThis) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
      }
      return new Response(JSON.stringify({
        model: 'jev-browser-smoke',
        answers: {
          destination: {
            type: 'choice',
            choice: 'valid',
            probabilities: { valid: 0.95, __no_match__: 0.05 },
            confidence: 0.96,
          },
        },
        usage: { input_tokens: 20, output_tokens: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByRole('button', { name: '测试连接' }).click();

  await expect(page.getByRole('status')).toHaveText('连接成功');
  await expect(page.getByLabel('JEV API 密钥')).toHaveAttribute('readonly');

  await serviceWorker.evaluate(() => {
    globalThis.fetch = async () => new Response('', { status: 401 });
  });
  await page.getByRole('button', { name: '测试连接' }).click();

  await expect(page.getByRole('status')).toHaveText('连接失败，请检查密钥');
  await expect(page.getByLabel('JEV API 密钥')).toBeEditable();
  await expect(page.getByLabel('JEV API 密钥')).toHaveValue('');
});

test('popup completes classification, bookmark move, content capture, and Undo', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const fixture = await openCapturedPage(context);
  const folders = await seedFolders(serviceWorker);
  await seedGrantedSettings(serviceWorker);
  await installJevResponse(serviceWorker, { status: 200, choice: folders.development });

  const popup = await openPopupPage(context, fixture, extensionId);
  await expect(popup.getByRole('heading', { name: '已自动收藏' })).toBeVisible();
  const savedFolderSelect = await popup.getByLabel('选择目录').boundingBox();
  expect(savedFolderSelect?.width).toBeGreaterThan(300);
  await popup.getByText('查看本次使用的网页信号').click();
  await expect(popup.getByText('Fixture description')).toBeVisible();
  await expect(popup.getByText('Capture heading', { exact: true })).toBeVisible();
  await expect(popup.getByText('Capture headingVisible browser smoke text', { exact: true }))
    .toBeVisible();

  const created = await bookmarksForUrl(serviceWorker, fixture.url());
  expect(created).toHaveLength(1);
  expect(created[0]?.parentId).toBe(folders.development);
  const createdId = created[0]?.id;

  await popup.getByLabel('选择目录').selectOption(folders.reading);
  await popup.getByRole('button', { name: '更改位置' }).click();
  await expect(popup.getByText('保存位置：书签栏 / Reading', { exact: true })).toBeVisible();
  const moved = await bookmarksForUrl(serviceWorker, fixture.url());
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({ id: createdId, parentId: folders.reading });

  await popup.getByRole('button', { name: '撤销' }).click();
  await expect(popup.getByRole('heading', { name: '已撤销' })).toBeVisible();
  await expect.poll(() => bookmarksForUrl(serviceWorker, fixture.url())).toHaveLength(0);
});

test('popup warns about a Duplicate Bookmark before JEV or mutation', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const fixture = await openCapturedPage(context);
  const folders = await seedFolders(serviceWorker);
  await seedGrantedSettings(serviceWorker);
  await serviceWorker.evaluate(
    ({ parentId, url }) => chrome.bookmarks.create({ parentId, title: 'Existing fixture', url }),
    { parentId: folders.development, url: fixture.url() },
  );
  await installJevResponse(serviceWorker, { status: 200, choice: folders.reading });

  const popup = await openPopupPage(context, fixture, extensionId);
  await expect(popup.getByRole('heading', { name: '发现重复收藏' })).toBeVisible();
  expect(await jevRequestCount(serviceWorker)).toBe(0);
  expect(await bookmarksForUrl(serviceWorker, fixture.url())).toHaveLength(1);
});

test('Pending Folder retry moves the same bookmark after a deterministic failure', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const fixture = await openCapturedPage(context);
  const folders = await seedFolders(serviceWorker);
  await seedGrantedSettings(serviceWorker);
  await installJevResponse(serviceWorker, { status: 401, choice: folders.development });

  const popup = await openPopupPage(context, fixture, extensionId);
  await expect(popup.getByRole('heading', { name: '已保存到待分类目录' })).toBeVisible();
  const pending = await bookmarksForUrl(serviceWorker, fixture.url());
  expect(pending).toHaveLength(1);
  const pendingId = pending[0]?.id;

  await installJevResponse(serviceWorker, { status: 200, choice: folders.development });
  await popup.getByRole('button', { name: '重试智能分类' }).click();
  await expect(popup.getByRole('heading', { name: '已自动收藏' })).toBeVisible();
  const retried = await bookmarksForUrl(serviceWorker, fixture.url());
  expect(retried).toHaveLength(1);
  expect(retried[0]).toMatchObject({ id: pendingId, parentId: folders.development });
});

async function openCapturedPage(context: BrowserContext) {
  await context.route('https://api.typesafe.ai/browser-smoke', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: [
        '<!doctype html><html><head><title>Browser smoke fixture</title>',
        '<meta name="description" content="Fixture description"></head>',
        '<body><nav>Excluded navigation</nav><main><h1>Capture heading</h1>',
        '<p>Visible browser smoke text</p><form><input value="secret"></form>',
        '</main></body></html>',
      ].join(''),
    });
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://api.typesafe.ai/browser-smoke');
  return page;
}

async function openPopupPage(
  context: BrowserContext,
  activePage: Awaited<ReturnType<typeof openCapturedPage>>,
  extensionId: string,
) {
  const popup = await context.newPage();
  await activePage.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

async function seedGrantedSettings(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => chrome.storage.local.set({
    smartSaveSettings: {
      consent: 'granted',
      apiKey: 'browser-smoke-secret',
      excludedFolderIds: [],
    },
  }));
}

async function seedFolders(serviceWorker: Worker): Promise<{
  development: string;
  reading: string;
}> {
  return serviceWorker.evaluate(async () => {
    const root = (await chrome.bookmarks.getTree())[0];
    const bookmarkBar = root?.children?.find((node) => node.id === '1') ?? root?.children?.[0];
    if (!bookmarkBar) throw new Error('Chrome bookmark bar root is unavailable');
    const development = await chrome.bookmarks.create({ parentId: bookmarkBar.id, title: 'Development' });
    const reading = await chrome.bookmarks.create({ parentId: bookmarkBar.id, title: 'Reading' });
    return { development: development.id, reading: reading.id };
  });
}

async function installJevResponse(
  serviceWorker: Worker,
  response: { status: number; choice: string },
): Promise<void> {
  await serviceWorker.evaluate(({ status, choice }) => {
    const scope = globalThis as typeof globalThis & { __smartFavoritesJevRequestCount?: number };
    scope.__smartFavoritesJevRequestCount = 0;
    scope.fetch = async () => {
      scope.__smartFavoritesJevRequestCount = (scope.__smartFavoritesJevRequestCount ?? 0) + 1;
      if (status !== 200) return new Response('', { status });
      return new Response(JSON.stringify({
        answers: {
          destination: {
            type: 'choice',
            choice,
            probabilities: { [choice]: 0.9, __no_match__: 0.1 },
            confidence: 0.95,
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, response);
}

async function jevRequestCount(serviceWorker: Worker): Promise<number> {
  return serviceWorker.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __smartFavoritesJevRequestCount?: number };
    return scope.__smartFavoritesJevRequestCount ?? 0;
  });
}

async function bookmarksForUrl(
  serviceWorker: Worker,
  url: string,
): Promise<Array<{
  id: string;
  parentId: string | undefined;
  title: string;
  url: string | undefined;
}>> {
  return serviceWorker.evaluate(async (targetUrl) => {
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] =>
      nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
    return walk(await chrome.bookmarks.getTree())
      .filter((node) => node.url === targetUrl)
      .map(({ id, parentId, title, url }) => ({ id, parentId, title, url }));
  }, url);
}
