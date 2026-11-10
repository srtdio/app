// Emoji reactions in catch up (9 Nov 2026): every message or comment a card
// (or the catch-up thread view) shows carries its chips under the text, the
// smiley pill last (ui/ReactionChips). With none yet, the smiley alone rides
// the row's top-right corner, out of the flow, so a row with no reactions
// keeps today's geometry. One batched read per card body (one query per card
// per kind: post / brief comments, plan comments, or chat messages), started
// after paint. Reacting writes only the reaction: it never marks the card
// read and never advances the stack.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconSmile } from '@/components/ui/icons';
import { AddReactionSheet, ReactionChips } from '@/components/ui/ReactionChips';
import { supabase } from '@/lib/supabase';
import type { CatchUpItemKind } from '@/lib/catch-up/queue';
import { ADD_REACTION_LABEL, type ReactionKind } from '@/lib/reactions/model';
import { whoReactedFromRows } from '@/lib/reactions/reads';
import { useReactions, type ReactionsApi } from '@/lib/reactions/use-reactions';

/** Where a card's rows keep their reactions. Pure. */
export function reactionKindOf(kind: CatchUpItemKind): ReactionKind {
  if (kind === 'chat-main' || kind === 'chat-thread') return 'chat';
  if (kind === 'plan-item' || kind === 'idea') return 'plan-comment';
  return 'comment';
}

/** The card (or thread view) a set of rows belongs to. */
export interface CatchUpReactionSource {
  kind: CatchUpItemKind;
  /** The post, brief, plan item or channel. */
  entityId: string;
  workspaceId: string;
}

/** One batched read for the rows on screen; `epoch` (the body read) re-reads them all. */
export function useCatchUpReactions(
  source: CatchUpReactionSource,
  ids: readonly string[],
  epoch: unknown,
): ReactionsApi {
  const kind = reactionKindOf(source.kind);
  return useReactions({
    kind,
    ids,
    epoch,
    ...(kind === 'chat' ? { channelId: source.entityId } : {}),
  });
}

/** The smiley alone (no reactions yet): a 44 key in the row's top-right corner. */
export const CATCH_UP_REACT_CLASS = 'absolute right-2 top-0 text-fg-3';

/** A row's reactions: the chips under the text, or the corner smiley when none. */
export function CatchUpRowReactions(props: {
  id: string;
  api: ReactionsApi;
  workspaceId: string;
  /** A parent that already spaces its children 8 (the thread root's stack): no extra top room. */
  flush?: boolean;
}): ReactElement {
  const { id, api } = props;
  const [drawer, setDrawer] = useState(false);
  const list = api.of(id);
  if (list.length > 0) {
    return (
      <ReactionChips
        className={props.flush === true ? '' : 'mt-1'}
        reactions={list}
        onToggle={(emoji) => api.toggle(id, emoji)}
        onPick={(emoji) => api.pick(id, emoji)}
        who={{
          targetId: id,
          viewerId: api.me,
          load: () =>
            whoReactedFromRows(supabase, {
              rows: api.rowsOf(id),
              workspaceId: props.workspaceId,
              known: () => undefined,
            }),
        }}
      />
    );
  }
  return (
    <>
      <IconButton
        type="button"
        label={ADD_REACTION_LABEL}
        data-reaction-add=""
        aria-haspopup="dialog"
        onClick={() => setDrawer(true)}
        className={CATCH_UP_REACT_CLASS}
      >
        <IconSmile size={ICON_SIZE.inline} />
      </IconButton>
      <AddReactionSheet
        open={drawer}
        onClose={() => setDrawer(false)}
        onPick={(emoji) => api.pick(id, emoji)}
      />
    </>
  );
}
