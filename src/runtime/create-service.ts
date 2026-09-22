import { SmartSaveService } from '../application/smart-save-service';
import { ChromeBookmarkPort } from '../adapters/chrome-bookmarks';
import { ChromePagePort } from '../adapters/chrome-page';
import { ChromeStoragePort } from '../adapters/chrome-storage';
import { HttpJevClient } from '../adapters/jev-client';

export function createSmartSaveService(): SmartSaveService {
  return new SmartSaveService({
    pages: new ChromePagePort(),
    bookmarks: new ChromeBookmarkPort(),
    jev: new HttpJevClient(),
    storage: new ChromeStoragePort(),
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => crypto.randomUUID() },
  });
}
