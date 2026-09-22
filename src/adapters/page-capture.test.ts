import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pageCaptureScript } from './page-capture';

describe('capturePageSignals', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('captures bounded safe visible signals and excludes form, navigation, code, and hidden text', () => {
    const longText = 'A'.repeat(4_200);
    const { document } = parseHTML(`
      <!doctype html>
      <html>
        <head>
          <title>Safe page</title>
          <meta name="description" content="A safe description">
          <style>.css-hidden { display: none }</style>
          <script>window.secret = 'script secret'</script>
        </head>
        <body>
          <nav>navigation secret</nav>
          <main>
            <h1>Primary heading</h1>
            <form>
              <label>Password <input type="password" value="password secret"></label>
              form secret
            </form>
            <p hidden>hidden attribute secret</p>
            <p aria-hidden="true">aria hidden secret</p>
            <p style="display:none">inline hidden secret</p>
            <p class="css-hidden">stylesheet hidden secret</p>
            <p>${longText}</p>
          </main>
        </body>
      </html>
    `);

    vi.stubGlobal('getComputedStyle', (element: Element) => ({
      display: element.classList.contains('css-hidden') ? 'none' : 'block',
      visibility: 'visible',
      opacity: '1',
    }));

    const result = pageCaptureScript('https://Example.COM:443/path?q=1#part', document);

    expect(result).toMatchObject({
      title: 'Safe page',
      url: 'https://Example.COM:443/path?q=1#part',
      domain: 'example.com',
      description: 'A safe description',
      h1: 'Primary heading',
      classificationAllowed: true,
    });
    expect(result.visibleText.length).toBeLessThanOrEqual(4_000);
    expect(result.visibleText).toContain('Primary heading');
    expect(result.visibleText).not.toMatch(/navigation secret|script secret|form secret|password secret|hidden secret/);
  });
});
