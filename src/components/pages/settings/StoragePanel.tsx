// Settings > Storage: how much of the workspace's 1 GB is used and what is
// using it (workspace_storage). Only from the 800 MB warning line on, and never
// for an exempt workspace, does it say anything about more space or talking to
// us. The meter turns bad at the Worker's upload cap (CAP_BYTES), which is
// never printed: the UI only says "full".

import { mark } from '@/lib/perf-marks';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { workspaceStorage } from '@srtdio/rpc';
import { RECENTLY_DELETED_PATH } from '@/components/storage/WorkspaceFullSheet';
import { wholeMb, type StorageUsage } from '@/components/storage/storage-usage';
import { BookCallSheet } from '@/components/support/BookCallSheet';
import { ContactSheet } from '@/components/support/ContactSheet';
import { SupportRows } from '@/components/support/SupportRows';
import { ActionRow } from '@/components/ui/ActionRow';
import { ICON_SIZE, IconTrash } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { CAP_BYTES } from '@/lib/storage-limits';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';

/** The free allowance the meter is drawn against: 1 GB (1024 MB). */
const ALLOWANCE_BYTES = 1024 * 1024 * 1024;

interface StorageBreakdown {
  bytes_used: number;
  library_bytes: number;
  chat_bytes: number;
  voice_bytes: number;
  deleted_bytes: number;
}

type MeterTone = 'accent' | 'warn' | 'bad';

/** The meter colour: warn from the warning line, bad once full (the cap). Exempt stays accent. */
export function meterTone(usedBytes: number, usage: StorageUsage | null): MeterTone {
  if (usage === null || usage.exempt) return 'accent';
  if (usedBytes >= CAP_BYTES) return 'bad';
  return usedBytes >= usage.warnAtBytes ? 'warn' : 'accent';
}

/** Whether "NEED MORE SPACE?" shows: at or past the warning line, not exempt. */
function showsNeedMoreSpace(usedBytes: number, usage: StorageUsage | null): boolean {
  return usage !== null && !usage.exempt && usedBytes >= usage.warnAtBytes;
}

const TONE_CLASS: Record<MeterTone, string> = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

const SECTION_LABEL = 'px-3 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

function mb(bytes: number): string {
  return `${wholeMb(bytes)} MB`;
}

function UsageLine(props: { label: string; bytes: number }) {
  return (
    <div className="flex min-h-[44px] items-center gap-3 px-3 text-base">
      <span className="min-w-0 flex-1 truncate text-fg">{props.label}</span>
      <span className="shrink-0 tabular-nums text-fg-2">{mb(props.bytes)}</span>
    </div>
  );
}

export function StoragePanel({ usage }: { usage: StorageUsage | null }) {
  const { workspaceId, workspaceDisplayName } = useWorkspace();
  const navigate = useNavigate();
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [support, setSupport] = useState<'contact' | 'book' | null>(null);

  useEffect(() => {
    setBreakdown(null);
    if (workspaceId === null) return;
    let active = true;
    mark('storage:start');
    void workspaceStorage(supabase, { p_workspace_id: workspaceId }).then((res) => {
      mark('storage:end');
      if (!active) return;
      if (!res.ok) {
        logger.warn('workspace_storage failed', { error: res.error.message });
        return;
      }
      setBreakdown(res.data[0] ?? null);
    });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  // /usage (workspace_bytes_used) is what the cap and the banner use: lead with it.
  const usedBytes = usage?.usedBytes ?? breakdown?.bytes_used ?? null;
  if (usedBytes === null || workspaceId === null) return null;
  const workspace = workspaceDisplayName ?? '';
  const tone = meterTone(usedBytes, usage);
  const fill = Math.min(usedBytes / ALLOWANCE_BYTES, 1);

  return (
    <div className="flex max-w-[520px] flex-col gap-6">
      <div className="flex flex-col gap-2.5">
        <p className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums text-fg">{mb(usedBytes)}</span>
          <span className="text-sm text-fg-3">of 1 GB</span>
        </p>
        <div
          role="meter"
          aria-label="Storage"
          aria-valuemin={0}
          aria-valuemax={ALLOWANCE_BYTES}
          aria-valuenow={Math.min(usedBytes, ALLOWANCE_BYTES)}
          data-tone={tone}
          className="h-2 w-full overflow-hidden rounded-full bg-panel-3"
        >
          <div
            className={cn('h-full rounded-full', TONE_CLASS[tone])}
            style={{ width: `${fill * 100}%` }}
          />
        </div>
        <p className="text-sm text-fg-3">{workspace} · everything in this workspace counts</p>
      </div>

      {breakdown !== null ? (
        <section className="-mx-3 flex flex-col">
          <h3 className={SECTION_LABEL}>WHAT&apos;S USING IT</h3>
          <UsageLine label="Assets" bytes={breakdown.library_bytes} />
          <UsageLine label="Chat files" bytes={breakdown.chat_bytes} />
          <UsageLine label="Voice notes" bytes={breakdown.voice_bytes} />
          <UsageLine label="Recently deleted" bytes={breakdown.deleted_bytes} />
        </section>
      ) : null}

      {showsNeedMoreSpace(usedBytes, usage) ? (
        <section className="-mx-3 flex flex-col gap-1">
          <h3 className={SECTION_LABEL}>NEED MORE SPACE?</h3>
          <p className="px-3 pb-1 text-base text-fg-2">
            Free up space in Recently deleted, or talk to us about more storage for {workspace}.
          </p>
          <ActionRow
            icon={<IconTrash size={ICON_SIZE.nav} />}
            label="Recently deleted"
            sub={`${mb(breakdown?.deleted_bytes ?? 0)} can be freed now`}
            onClick={() => navigate(RECENTLY_DELETED_PATH)}
            chevron
          />
          <SupportRows onContact={() => setSupport('contact')} onBook={() => setSupport('book')} />
        </section>
      ) : null}

      <ContactSheet
        open={support === 'contact'}
        onClose={() => setSupport(null)}
        workspaceName={workspace}
      />
      <BookCallSheet
        open={support === 'book'}
        onClose={() => setSupport(null)}
        workspaceId={workspaceId}
      />
    </div>
  );
}
