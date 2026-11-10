import { cell, type GalleryCell } from './frame';
import { IconButton } from '@/components/ui/IconButton';
import { IconMore, IconTrash } from '@/components/ui/icons';

export const part = 'IconButton';

const noop = () => undefined;

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <IconButton label="More" onClick={noop}>
      <IconMore />
    </IconButton>
  )),
  cell('disabled', () => (
    <IconButton label="More" disabled onClick={noop}>
      <IconMore />
    </IconButton>
  )),
  cell('narrow-320', () => (
    <IconButton label="Delete" onClick={noop}>
      <IconTrash />
    </IconButton>
  )),
  cell('all-slots-on', () => (
    <IconButton label="Delete" type="button" onClick={noop}>
      <IconTrash />
    </IconButton>
  )),
  cell('all-slots-off', () => <IconButton label="More" />),
];
