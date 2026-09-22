import { BookmarksSimple } from '@phosphor-icons/react';

export function BrandMark({ size = 'medium' }: { size?: 'small' | 'medium' }) {
  return (
    <span className={`brand-mark brand-mark-${size}`} aria-hidden="true">
      <BookmarksSimple weight="fill" />
    </span>
  );
}
