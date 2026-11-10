import { cell, type GalleryCell } from './frame';
import { Tag } from '@/components/ui/Tag';
import { IconClock } from '@/components/ui/icons';
import { LONG_TEXT, LONGEST_NAME, ONE_LONG_WORD } from './fixtures';

export const part = 'Tag';

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Tag label="Approver" />
      <Tag label="Open" tone="accent" />
      <Tag label="Approved" tone="good" />
      <Tag label="Review" tone="warn" />
      <Tag label="Not delivered" tone="bad" />
      <Tag label="Review" dot="review" />
      <Tag label="Approved" dot="approved" />
      <Tag label="Rejected" dot="rejected" />
      <Tag label="Parked" dot="parked" />
      <Tag label="Draft" dot="draft" />
    </div>
  )),
  cell('long-text', () => <Tag label={LONG_TEXT} />),
  cell('one-long-word', () => <Tag label={ONE_LONG_WORD} />),
  cell('no-text', () => <Tag label="" />),
  cell('longest-name', () => <Tag label={LONGEST_NAME} />),
  cell('narrow-320', () => <Tag label="Review" dot="review" />),
  cell('all-slots-on', () => <Tag label="Review" tone="warn" dot="review" icon={IconClock} />),
  cell('all-slots-off', () => <Tag label="Approver" />),
];
