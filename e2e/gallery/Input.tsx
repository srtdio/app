import { cell, type GalleryCell } from './frame';
import { Input } from '@/components/ui/Input';
import { LONG_TEXT, LONGEST_NAME, NAME, ONE_LONG_WORD } from './fixtures';

export const part = 'Input';

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Input aria-label="Name" placeholder="Name" />
      <Input aria-label="Search" type="search" tone="search" placeholder="Search" />
    </div>
  )),
  cell('disabled', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Input aria-label="Name" defaultValue={NAME} disabled />
      <Input aria-label="Search" type="search" tone="search" placeholder="Search" disabled />
    </div>
  )),
  cell('long-text', () => <Input aria-label="Title" defaultValue={LONG_TEXT} />),
  cell('one-long-word', () => <Input aria-label="Title" defaultValue={ONE_LONG_WORD} />),
  cell('no-text', () => <Input aria-label="Title" />),
  cell('longest-name', () => (
    <Input aria-label="Name" defaultValue={LONGEST_NAME} maxLength={25} counter="25/25" />
  )),
  cell('narrow-320', () => (
    <Input aria-label="Name" defaultValue={NAME} maxLength={25} counter="10/25" />
  )),
  cell('all-slots-on', () => (
    <Input
      aria-label="Name"
      tone="field"
      placeholder="Name"
      defaultValue={LONGEST_NAME}
      maxLength={25}
      counter="25/25"
    />
  )),
  cell('all-slots-off', () => <Input />),
];
