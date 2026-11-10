import { cell, type GalleryCell } from './frame';
import { Toolbar } from '@/components/ui/Toolbar';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconFilterLines, IconSort } from '@/components/ui/icons';

export const part = 'Toolbar';

const noop = (): undefined => undefined;

const CHIPS = (
  <div className="flex flex-wrap items-start gap-2">
    <Chip label="All" selected onClick={noop} />
    <Chip label="Review" onClick={noop} />
    <Chip label="Approved" onClick={noop} />
  </div>
);

const SORT = (
  <IconButton label="Sort" onClick={noop}>
    <IconSort size={ICON_SIZE.control} />
  </IconButton>
);

const FILTER = (
  <IconButton label="Filter" onClick={noop}>
    <IconFilterLines size={ICON_SIZE.control} />
  </IconButton>
);

const NEW = (
  <Button variant="primary" onClick={noop}>
    New
  </Button>
);

export const cells: readonly GalleryCell[] = [
  cell('default', () => <Toolbar context={CHIPS} icons={SORT} primary={NEW} />),
  cell('zero-items', () => <Toolbar context={CHIPS} icons={[]} primary={NEW} />),
  cell('one-item', () => <Toolbar context={CHIPS} icons={SORT} />),
  cell('narrow-320', () => <Toolbar context={CHIPS} icons={SORT} primary={NEW} />),
  cell('all-slots-on', () => (
    <Toolbar
      context={CHIPS}
      icons={
        <>
          {FILTER}
          {SORT}
        </>
      }
      primary={NEW}
      flush
    />
  )),
  cell('all-slots-off', () => <Toolbar />),
];
