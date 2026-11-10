import { cell, type GalleryCell } from './frame';
import { Text } from '@/components/ui/Text';
import { LONG_TEXT, LONGEST_NAME, NAME, ONE_LONG_WORD, SHORT } from './fixtures';

export const part = 'Text';

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Text role="display">{SHORT}</Text>
      <Text role="title">{SHORT}</Text>
      <Text role="heading">{NAME}</Text>
      <Text role="body">{SHORT}</Text>
      <Text role="secondary">{SHORT}</Text>
      <Text role="label">{SHORT}</Text>
      <Text role="meta">2:14 PM</Text>
      <Text role="section">{SHORT}</Text>
    </div>
  )),
  cell('long-text', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Text role="body">{LONG_TEXT}</Text>
      <Text role="secondary">{LONG_TEXT}</Text>
    </div>
  )),
  cell('one-long-word', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Text role="body">{ONE_LONG_WORD}</Text>
      <Text role="secondary">{ONE_LONG_WORD}</Text>
    </div>
  )),
  cell('no-text', () => <Text role="body" />),
  cell('longest-name', () => <Text role="heading">{LONGEST_NAME}</Text>),
  cell('narrow-320', () => <Text role="body">{LONG_TEXT}</Text>),
  cell('all-slots-on', () => (
    <Text role="meta" as="time" ariaRole="note" dateTime="2026-11-10T14:14:00Z">
      2:14 PM
    </Text>
  )),
  cell('all-slots-off', () => <Text role="body">{SHORT}</Text>),
];
