import type { CapturedPage } from '../application/types';

export function pageCaptureScript(url: string, documentOverride?: Document): CapturedPage {
  const source = documentOverride ?? document;
  const root = source.querySelector('article') ?? source.querySelector('main') ?? source.body;
  const safeRoot = root?.cloneNode(true) as Element | null;

  if (root && safeRoot) {
    const sourceElements = [root, ...root.querySelectorAll('*')];
    const safeElements = [safeRoot, ...safeRoot.querySelectorAll('*')];
    if (typeof getComputedStyle === 'function') {
      sourceElements.forEach((element, index) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          const safeElement = safeElements[index];
          if (index === 0) safeRoot.textContent = '';
          else safeElement?.remove();
        }
      });
    }
    safeRoot
      .querySelectorAll(
        'script, style, nav, form, input, textarea, select, option, button, [hidden], [aria-hidden="true"]',
      )
      .forEach((element) => element.remove());
    safeRoot.querySelectorAll('[style]').forEach((element) => {
      const style = element.getAttribute('style') ?? '';
      if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) element.remove();
    });
  }

  const normalizedText = (safeRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const parsedUrl = new URL(url);
  return {
    title: source.title.trim(),
    url,
    domain: parsedUrl.hostname.toLowerCase(),
    description:
      source.querySelector<HTMLMetaElement>('meta[name="description"]')?.content.trim() ?? '',
    h1: source.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    visibleText: normalizedText.slice(0, 4_000),
    classificationAllowed: true,
  };
}
