import { cell, type GalleryCell } from './frame';
import { Chip } from '@/components/ui/Chip';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tag } from '@/components/ui/Tag';
import { LONG_TEXT, LONGEST_NAME, MAX_NUMBER, ONE_LONG_WORD } from './fixtures';

export const part = 'Chip';

const noop = () => undefined;

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Chip label="All" selected={false} onClick={noop} />
      <Chip label="Review" dot={<StatusDot stage="review" />} count={3} onClick={noop} />
      <Chip label="Add idea" variant="add" onClick={noop} />
    </div>
  )),
  cell('selected', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Chip label="All" selected onClick={noop} />
      <Chip label="Photos" tab selected size="tap" onClick={noop} />
    </div>
  )),
  cell('disabled', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Chip label="All" disabled onClick={noop} />
      <Chip label="Review" selected disabled onClick={noop} />
      <Chip label="Add idea" variant="add" disabled onClick={noop} />
    </div>
  )),
  cell('long-text', () => <Chip label={LONG_TEXT} onClick={noop} />),
  cell('one-long-word', () => <Chip label={ONE_LONG_WORD} onClick={noop} />),
  cell('no-text', () => <Chip label="" onClick={noop} />),
  cell('zero-items', () => <Chip label="Review" count={0} onClick={noop} />),
  cell('one-item', () => <Chip label="Review" count={1} onClick={noop} />),
  cell('max-number', () => <Chip label="Review" count={MAX_NUMBER} onClick={noop} />),
  cell('longest-name', () => <Chip label={LONGEST_NAME} selected={false} onClick={noop} />),
  cell('narrow-320', () => (
    <div className="flex flex-col items-start gap-2">
      <Chip label="Review" dot={<StatusDot stage="review" />} count={12} onClick={noop} />
      <Chip label={LONG_TEXT} count={MAX_NUMBER} onClick={noop} />
    </div>
  )),
  cell('all-slots-on', () => (
    <Chip
      label="Week plan"
      dot={<StatusDot stage="review" />}
      trailing={<Tag label="Draft" />}
      count={4}
      selected
      size="tap"
      onClick={noop}
      onClear={noop}
    />
  )),
  cell('all-slots-off', () => <Chip label="All" />),
];
