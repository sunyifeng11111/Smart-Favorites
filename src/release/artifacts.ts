const APPROVED_PERMISSIONS = ['activeTab', 'bookmarks', 'scripting', 'storage'];
const APPROVED_HOST_ACCESS = ['https://api.typesafe.ai/*'];

export function verifyProductionManifest(value: unknown): void {
  const manifest = asRecord(value);
  if (!manifest) throw new Error('Production manifest must be a JSON object');
  if (manifest.manifest_version !== 3) {
    throw new Error('Production manifest must use Manifest V3');
  }
  if (!sameStrings(manifest.permissions, APPROVED_PERMISSIONS)) {
    throw new Error('Production manifest permissions differ from the approved permission set');
  }
  if (!sameStrings(manifest.host_permissions, APPROVED_HOST_ACCESS)) {
    throw new Error('Production manifest host access differs from the approved JEV endpoint');
  }

  const background = asRecord(manifest.background);
  const action = asRecord(manifest.action);
  const options = asRecord(manifest.options_ui);
  if (
    typeof background?.service_worker !== 'string' ||
    typeof action?.default_popup !== 'string' ||
    typeof options?.page !== 'string'
  ) {
    throw new Error('Production manifest is missing required browser wiring');
  }
}

export function expectedChromeZipName(name: string, version: string): string {
  return `${name}-${version}-chrome.zip`;
}

function sameStrings(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return false;
  return [...value].sort().join('\n') === [...expected].sort().join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
