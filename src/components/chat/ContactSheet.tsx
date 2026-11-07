// The DM Contact page, full screen over the app: the peer's photo, name and
// role line, then the shared chat info tabs (ChatInfoTabs, full mode): Media,
// Files and Links. The page opens and closes without motion; colours
// are tokens only, so light and dark match.

import { createPortal } from 'react-dom';
import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { HeaderBar } from '@/components/ui/HeaderBar';
import {
  ChatInfoTabs,
  ChatInfoTabsView,
  type ChatInfoTabsViewProps,
  type InfoSelectChrome,
} from '@/components/chat/ChatInfoTabs';
import type { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { RemovableFile } from '@/lib/chat/remove-files';

export {
  appendPage,
  CONTACT_EMPTY,
  FEED_LOADING,
  FeedBody,
  feedForTab,
  showLoadMore,
  type ContactTab,
  type Feed,
} from '@/components/chat/ChatInfoTabs';
import { MODAL_HEADER_SAFE, MODAL_PAGE_CLASS, ModalPanel } from '@/components/chat/ModalPanel';
import { textRole } from '@/components/ui/Text';

/** The page title when no `heading` is given. */
const CONTACT_HEADING = 'Contact info';

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

/**
 * The page chrome around the tabs: back bar, photo, name, role line. With
 * `select`, the bar carries Select top right; in select mode the bar is "n
 * selected" and Cancel, and the Remove bar sits under the page. Hook-free.
 */
function contactPage(props: {
  heading: string;
  onClose: () => void;
  title: string;
  avatarUrl: string | null;
  roleLine: string | null;
  tabs: ReactElement;
  select?: InfoSelectChrome;
}): ReactElement {
  const select = props.select;
  return (
    <ModalPanel aria-label={props.heading} data-contact-page="" className={MODAL_PAGE_CLASS}>
      {select?.selecting === true && select.selectHeader !== null ? (
        // Select mode: the same HeaderBar holds "n selected" and Cancel, so
        // the title sits on the one edge in both modes.
        <HeaderBar
          compact
          className={MODAL_HEADER_SAFE}
          title={select.selectHeader.title}
          actions={select.selectHeader.cancel}
        />
      ) : (
        // A modal page: Back left, the title, Select (when offered) right. One exit.
        <HeaderBar
          compact
          className={MODAL_HEADER_SAFE}
          title={props.heading}
          onBack={props.onClose}
          backProps={{ label: `Close ${props.heading.toLowerCase()}` }}
          {...(select?.header !== null && select?.header !== undefined
            ? { actions: select.header }
            : {})}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
          <div className="flex flex-col items-center gap-1 text-center">
            <ContactPhoto name={props.title} avatarUrl={props.avatarUrl} />
            <span className={textRole('heading', 'mt-2 max-w-full truncate text-fg')}>
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
      {select?.bar ?? null}
    </ModalPanel>
  );
}

export interface ContactSheetViewProps extends Omit<
  ChatInfoTabsViewProps,
  'mode' | 'expanded' | 'onSeeAll'
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
  const { onClose, heading, title, avatarUrl, roleLine, ...tabs } = props;
  return contactPage({
    heading: heading ?? CONTACT_HEADING,
    onClose,
    title,
    avatarUrl,
    roleLine,
    tabs: ChatInfoTabsView({ ...tabs, mode: 'full' }),
  });
}

interface ContactSheetProps {
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
  /** Remove own files from Media / Files (Select, the viewer's bin); absent hides both. */
  onRemoveFiles?: (files: RemovableFile[]) => void;
}

/** The stateful page: ChatInfoTabs owns the tab, feeds and lightbox. Key it by channel. */
export function ContactSheet(props: ContactSheetProps): ReactElement {
  const { onClose } = props;
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
      onEscape={onClose}
      {...(props.onRemoveFiles !== undefined ? { onRemoveFiles: props.onRemoveFiles } : {})}
      frame={(tabs, select) =>
        contactPage({
          heading,
          onClose,
          title: props.title,
          avatarUrl: props.avatarUrl,
          roleLine: props.roleLine,
          tabs,
          select,
        })
      }
    />,
    document.body,
  );
}
