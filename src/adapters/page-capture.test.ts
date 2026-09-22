import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { capturePageSignals } from './page-capture';

describe('capturePageSignals', () => {
  it('captures bounded safe visible signals and excludes form, navigation, code, and hidden text', () => {
    const longText = 'A'.repeat(4_200);
    const { document } = parseHTML(`
      <!doctype html>
      <html>
        <head>
          <title>Safe page</title>
          <meta name="description" content="A safe description">
          <style>.secret { display: block }</style>
          <script>window.secret = 'script secret'</script>
        </head>
        <body>
          <nav>navigation secret</nav>
          <main>
            <h1>Primary heading</h1>
            <p>${longText}</p>
            <form>
              <label>Password <input type="password" value="password secret"></label>
              form secret
            </form>
            <p hidden>hidden attribute secret</p>
            <p aria-hidden="true">aria hidden secret</p>
            <p style="display:none">inline hidden secret</p>
          </main>
        </body>
      </html>
    `);

    const result = capturePageSignals(document, 'https://Example.COM:443/path?q=1#part');

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
