export function httpDomain(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
