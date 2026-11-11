import { cell, type GalleryCell } from './frame';
import { Button } from '@/components/ui/Button';
import { IconSend } from '@/components/ui/icons';
import { LONG_TEXT, LONGEST_NAME, ONE_LONG_WORD } from './fixtures';

export const part = 'Button';

const noop = () => undefined;

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Button variant="primary" onClick={noop}>
        Save
      </Button>
      <Button variant="secondary" onClick={noop}>
        Load more
      </Button>
      <Button variant="ghost" onClick={noop}>
        Cancel
      </Button>
      <Button variant="link" onClick={noop}>
        Edit
      </Button>
      <Button variant="success" onClick={noop}>
        Approve
      </Button>
      <Button variant="danger" onClick={noop}>
        Delete
      </Button>
    </div>
  )),
  cell('disabled', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Button variant="primary" disabled onClick={noop}>
        Save
      </Button>
      <Button variant="secondary" disabled onClick={noop}>
        Load more
      </Button>
      <Button variant="ghost" disabled onClick={noop}>
        Cancel
      </Button>
      <Button variant="link" disabled onClick={noop}>
        Edit
      </Button>
      <Button variant="success" disabled onClick={noop}>
        Approve
      </Button>
      <Button variant="danger" disabled onClick={noop}>
        Delete
      </Button>
      <Button variant="primary" aria-disabled="true" onClick={noop}>
        New
      </Button>
    </div>
  )),
  cell('pending', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Button variant="primary" busy onClick={noop}>
        Send for review
      </Button>
      <Button variant="secondary" busy onClick={noop}>
        Load more
      </Button>
    </div>
  )),
  cell('long-text', () => (
    <Button variant="primary" onClick={noop}>
      {LONG_TEXT}
    </Button>
  )),
  cell('one-long-word', () => (
    <Button variant="primary" onClick={noop}>
      {ONE_LONG_WORD}
    </Button>
  )),
  cell('no-text', () => <Button variant="secondary" aria-label="Save" onClick={noop} />),
  cell('longest-name', () => (
    <Button variant="secondary" onClick={noop}>
      {LONGEST_NAME}
    </Button>
  )),
  cell('narrow-320', () => (
    <div className="flex flex-col items-start gap-2">
      <Button variant="primary" onClick={noop}>
        Send for review
      </Button>
      <Button variant="secondary" onClick={noop}>
        {LONG_TEXT}
      </Button>
    </div>
  )),
  cell('all-slots-on', () => (
    <Button variant="primary" shape="round" aria-label="Send" type="button" onClick={noop}>
      <IconSend />
    </Button>
  )),
  cell('all-slots-off', () => <Button>Load more</Button>),
];
