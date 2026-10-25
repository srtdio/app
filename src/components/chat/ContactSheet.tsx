// The DM Contact page, full screen over the app: the peer's photo, name and
// role line, then the shared chat info tabs (ChatInfoTabs, full mode): Media,
// Files, Links and Marks. The page opens and closes without motion; colours
// are tokens only, so light and dark match.

import { createPortal } from 'react-dom';
import type { ReactElement } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';
import {
  ChatInfoTabs,
  ChatInfoTabsView,
  type ChatInfoTabsViewProps,
} from '@/components/chat/ChatInfoTabs';
import type { MarksListProps } from '@/components/chat/MarksSheet';
import type { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';

export {
  appendPage,
  CONTACT_EMPTY,
  CONTACT_TABS,
  contactSenderName,
  FEED_LOADING,
  FeedBody,
  feedForTab,
  fileMetaLine,
  LinkRow,
  showLoadMore,
  type ContactTab,
  type Feed,
} from '@/components/chat/ChatInfoTabs';
import { ModalPanel } from '@/components/chat/ModalPanel';

/** The page title when no `heading` is given. */
export const CONTACT_HEADING = 'Contact info';

/**
 * The contact photo: the shared Avatar at its profile role (72px circle). With
 * no photo it shows initials on the same avatar fill the list and the chat
 * header give this person, so they read as one person.
 */
function ContactPhoto(props: { name: string; avatarUrl: string | null }): ReactElement {
  return (
    <Avatar
      role="profile"
      name={props.name}
      {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
    />
  );
}

/** The page chrome around the tabs: back bar, photo, name, role line. Hook-free. */
function contactPage(props: {
  heading: string;
  onClose: () => void;
  title: string;
  avatarUrl: string | null;
  roleLine: string | null;
  tabs: ReactElement;
}): ReactElement {
  return (
    <ModalPanel
      aria-label={props.heading}
      data-contact-page=""
      className="fixed inset-0 z-50 flex flex-col bg-bg outline-none"
    >
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-2 md:px-4">
        <IconButton label={`Close ${props.heading.toLowerCase()}`} onClick={props.onClose}>
          <IconChevronLeft size={ICON_SIZE.control} />
        </IconButton>
        <h2 className="truncate text-lg font-semibold text-fg">{props.heading}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
          <div className="flex flex-col items-center gap-1 text-center">
            <ContactPhoto name={props.title} avatarUrl={props.avatarUrl} />
            <span className="mt-2 max-w-full truncate text-lg font-semibold text-fg">
              {props.title}
            </span>
            {props.roleLine !== null ? (
              <span data-role-line="" className="max-w-full truncate text-base text-fg-2">
                {props.roleLine}
              </span>
            ) : null}
          </div>
          {props.tabs}
        </div>
      </div>
    </ModalPanel>
  );
}

export interface ContactSheetViewProps extends Omit<
  ChatInfoTabsViewProps,
  'open' | 'mode' | 'expanded' | 'onSeeAll'
> {
  open: boolean;
  onClose: () => void;
  /** The page title; defaults to "Contact info". */
  heading?: string;
  title: string;
  avatarUrl: string | null;
  /** The DM header's "role · workspace" line (dmHeaderLine); null hides it. */
  roleLine: string | null;
}

/** The page's tree for a given state. Hook-free so tests walk it directly. */
export function ContactSheetView(props: ContactSheetViewProps): ReactElement | null {
  if (!props.open) return null;
  const { open, onClose, heading, title, avatarUrl, roleLine, onJump, ...tabs } = props;
  return contactPage({
    heading: heading ?? CONTACT_HEADING,
    onClose,
    title,
    avatarUrl,
    roleLine,
    tabs: ChatInfoTabsView({
      ...tabs,
      open,
      mode: 'full',
      onJump: (messageId) => {
        onClose();
        onJump(messageId);
      },
    }),
  });
}

export interface ContactSheetProps {
  open: boolean;
  onClose: () => void;
  /** The page title; defaults to "Contact info". */
  heading?: string;
  channelId: string;
  title: string;
  avatarUrl: string | null;
  roleLine: string | null;
  profiles: Map<string, ChatProfile>;
  currentUserId: string;
  /** For tests: the zone dates render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  cache: PresignCache;
  presignEnabled: boolean;
  marks: Omit<MarksListProps, 'open' | 'onJump'> | null;
  onJump: (messageId: string) => void;
}

/** The stateful page: ChatInfoTabs owns the tab, feeds and lightbox. Key it by channel. */
export function ContactSheet(props: ContactSheetProps): ReactElement {
  const { onClose, onJump } = props;
  const heading = props.heading ?? CONTACT_HEADING;
  return createPortal(
    <ChatInfoTabs
      mode="full"
      open={props.open}
      channelId={props.channelId}
      profiles={props.profiles}
      currentUserId={props.currentUserId}
      timeZone={props.timeZone}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      marks={props.marks}
      onJump={(messageId) => {
        onClose();
        onJump(messageId);
      }}
      onEscape={onClose}
      frame={(tabs) =>
        contactPage({
          heading,
          onClose,
          title: props.title,
          avatarUrl: props.avatarUrl,
          roleLine: props.roleLine,
          tabs,
        })
      }
    />,
    document.body,
  );
}
