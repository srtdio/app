import { cell, type GalleryCell } from './frame';
import { Avatar } from '@/components/ui/Avatar';
import { BROKEN_PHOTO, LONG_TEXT, LONGEST_NAME, NAME, ONE_LONG_WORD, PHOTO } from './fixtures';

export const part = 'Avatar';

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Avatar name={NAME} src={PHOTO} role="inline" />
      <Avatar name={NAME} src={PHOTO} role="stack" />
      <Avatar name={NAME} src={PHOTO} role="header" />
      <Avatar name={NAME} src={PHOTO} role="row" />
      <Avatar name={NAME} src={PHOTO} role="card" />
      <Avatar name={NAME} src={PHOTO} role="profile" />
    </div>
  )),
  cell('long-text', () => <Avatar name={LONG_TEXT} role="card" />),
  cell('one-long-word', () => <Avatar name={ONE_LONG_WORD} role="card" />),
  cell('no-text', () => <Avatar role="card" />),
  cell('longest-name', () => <Avatar name={LONGEST_NAME} role="card" />),
  cell('missing-picture', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Avatar name={NAME} role="inline" />
      <Avatar name={NAME} role="stack" />
      <Avatar name={NAME} role="header" />
      <Avatar name={NAME} role="row" />
      <Avatar name={NAME} role="card" />
      <Avatar name={NAME} role="profile" />
    </div>
  )),
  cell('failed-picture', () => <Avatar name={NAME} src={BROKEN_PHOTO} role="card" />),
  cell('narrow-320', () => (
    <div className="flex flex-wrap items-start gap-2">
      <Avatar name={NAME} src={PHOTO} role="row" />
      <Avatar name={NAME} role="row" presence="online" />
      <Avatar name="Design team" role="row" kind="group" />
    </div>
  )),
  cell('all-slots-on', () => (
    <Avatar name={NAME} src={PHOTO} role="profile" kind="group" presence="online" decorative />
  )),
  cell('all-slots-off', () => <Avatar role="row" />),
];
