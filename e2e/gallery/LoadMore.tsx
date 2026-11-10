import { cell, type GalleryCell } from './frame';
import { LoadMore } from '@/components/ui/LoadMore';

export const part = 'LoadMore';

const noop = (): undefined => undefined;

export const cells: readonly GalleryCell[] = [
  cell('loading', () => <LoadMore busy onMore={noop} />),
  cell('default', () => <LoadMore busy={false} onMore={noop} />),
  cell('narrow-320', () => <LoadMore busy={false} onMore={noop} />),
  cell('all-slots-off', () => <LoadMore busy={false} onMore={noop} />),
];
