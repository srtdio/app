import { cell, type GalleryCell } from './frame';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { Text } from '@/components/ui/Text';
import { ICON_SIZE, IconMore, IconSearch } from '@/components/ui/icons';
import { LONG_TEXT, LONGEST_NAME, NAME, ONE_LONG_WORD, PHOTO, SHORT } from './fixtures';

export const part = 'HeaderBar';

const noop = (): undefined => undefined;

const ACTIONS = (
  <>
    <IconButton label="Search" onClick={noop}>
      <IconSearch size={ICON_SIZE.control} />
    </IconButton>
    <IconButton label="More" onClick={noop}>
      <IconMore size={ICON_SIZE.control} />
    </IconButton>
  </>
);

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-col">
      <HeaderBar title={SHORT} onBack={noop} />
      <HeaderBar title={SHORT} mark={<Avatar name={NAME} src={PHOTO} role="header" />} />
    </div>
  )),
  cell('long-text', () => (
    <HeaderBar title={LONG_TEXT} subtitle={LONG_TEXT} onBack={noop} actions={ACTIONS} />
  )),
  cell('one-long-word', () => (
    <HeaderBar title={ONE_LONG_WORD} subtitle={ONE_LONG_WORD} onBack={noop} actions={ACTIONS} />
  )),
  cell('no-text', () => <HeaderBar title="" onBack={noop} />),
  cell('longest-name', () => (
    <HeaderBar title={LONGEST_NAME} subtitle="online" onBack={noop} actions={ACTIONS} />
  )),
  cell('narrow-320', () => (
    <HeaderBar title={SHORT} subtitle="4 members" onBack={noop} actions={ACTIONS} compact />
  )),
  cell('all-slots-on', () => (
    <HeaderBar
      title={SHORT}
      subtitle="4 members"
      onBack={noop}
      backProps={{ label: 'Close' }}
      actions={ACTIONS}
      routeFocus
      titleProps={{ 'data-gallery-title': '' }}
      pinned
      below={<Text role="meta">2 of 3 points resolved</Text>}
    />
  )),
  cell('all-slots-off', () => <HeaderBar title={SHORT} />),
];
