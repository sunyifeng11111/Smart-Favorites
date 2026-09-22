import { browser, type Browser } from 'wxt/browser';

import type { BookmarkNode, BookmarkPort } from '../application/types';

export class ChromeBookmarkPort implements BookmarkPort {
  async getTree(): Promise<BookmarkNode[]> {
    return (await browser.bookmarks.getTree()).map(mapBookmarkNode);
  }

  async create(input: { parentId: string; title: string; url: string }): Promise<BookmarkNode> {
    return mapBookmarkNode(await browser.bookmarks.create(input));
  }

  async move(
    id: string,
    destination: { parentId: string; index?: number },
  ): Promise<BookmarkNode> {
    return mapBookmarkNode(await browser.bookmarks.move(id, destination));
  }

  async remove(id: string): Promise<void> {
    await browser.bookmarks.remove(id);
  }
}

function mapBookmarkNode(node: Browser.bookmarks.BookmarkTreeNode): BookmarkNode {
  return {
    id: node.id,
    title: node.title,
    ...(node.parentId == null ? {} : { parentId: node.parentId }),
    ...(node.url == null ? {} : { url: node.url }),
    ...(node.dateAdded == null ? {} : { dateAdded: node.dateAdded }),
    ...(node.children == null ? {} : { children: node.children.map(mapBookmarkNode) }),
  };
}
