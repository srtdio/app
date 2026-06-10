import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHead } from '@/components/shell/PageHead';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { IconUser } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { computeSeatUsage, countActiveMembers, isPlanTier } from '@srtdio/workspace';
import type { SeatUsage } from '@srtdio/workspace';

const PANELS: TabItem[] = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'members', label: 'Members' },
  { key: 'billing', label: 'Billing' },
  { key: 'profile', label: 'Profile' },
];

function isPanelKey(value: string | null): value is string {
  return value !== null && PANELS.some((panel) => panel.key === value);
}

function WorkspacePanel() {
  return (
    <div className="max-w-[520px] flex flex-col gap-4">
      <Field label="Workspace name">
        <Input placeholder="Workspace name" />
      </Field>
      <Field label="Timezone">
        <Input placeholder="Select timezone" />
      </Field>
      <Field label="Default digest time">
        <Input placeholder="9:00 AM" />
      </Field>
      <div>
        <Button variant="primary">Save changes</Button>
      </div>
    </div>
  );
}

function SeatUsageMeter({ usage }: { usage: SeatUsage }) {
  const percent =
    usage.unlimited || usage.limit === null || usage.limit === 0
      ? 0
      : Math.min(100, Math.round((usage.used / usage.limit) * 100));
  const summary = usage.unlimited
    ? `${usage.used} in use, unlimited`
    : `${usage.used} of ${usage.limit} in use`;
  const caption = usage.unlimited
    ? 'This plan includes unlimited members.'
    : usage.atCapacity
      ? 'All seats are in use. Upgrade the plan to invite more members.'
      : `${usage.remaining} ${usage.remaining === 1 ? 'seat' : 'seats'} available.`;

  return (
    <div className="rounded-xl border border-border bg-panel-2 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-semibold">Seats</div>
        <div className="text-sm text-fg-3">{summary}</div>
      </div>
      {usage.unlimited ? null : (
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-label="Seats in use"
          aria-valuemin={0}
          aria-valuemax={usage.limit ?? undefined}
          aria-valuenow={usage.used}
        >
          <div
            className={`h-full rounded-full ${usage.atCapacity ? 'bg-warn' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <div className="mt-2 text-sm text-fg-3">{caption}</div>
    </div>
  );
}

function MembersPanel() {
  const { workspaceId, workspaces } = useWorkspace();
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const planTier = useMemo(() => {
    const row = workspaces.find((w) => w.id === workspaceId);
    return row && isPlanTier(row.plan_tier) ? row.plan_tier : 'solo';
  }, [workspaces, workspaceId]);

  useEffect(() => {
    if (workspaceId === null) return;
    let active = true;
    setError(null);
    void countActiveMembers(supabase, workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setCount(result.data);
    });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const usage = count === null ? null : computeSeatUsage(planTier, count);

  return (
    <div className="max-w-[520px] flex flex-col gap-4">
      {error !== null ? (
        <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
          Could not load seat usage. {error}
        </div>
      ) : usage !== null ? (
        <SeatUsageMeter usage={usage} />
      ) : null}
      <EmptyState
        icon={<IconUser size={24} />}
        title="No members yet"
        description="Invite teammates and clients to collaborate in this workspace."
        action={
          <Button variant="primary" disabled={usage?.atCapacity ?? false}>
            Invite member
          </Button>
        }
      />
    </div>
  );
}

function BillingPanel() {
  return (
    <div className="max-w-[520px]">
      <div className="rounded-xl border border-border bg-panel-2 p-4">
        <div className="text-sm font-semibold">Plan</div>
        <div className="mt-1 text-sm text-fg-3">No billing information yet.</div>
      </div>
    </div>
  );
}

function ProfilePanel() {
  return (
    <div className="max-w-[520px] flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar size="lg" />
        <Button>Change photo</Button>
      </div>
      <Field label="Display name">
        <Input placeholder="Your name" />
      </Field>
      <Field label="Designation">
        <Input placeholder="Your role" />
      </Field>
      <div>
        <Button variant="primary">Save profile</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [params] = useSearchParams();
  const requested = params.get('panel');
  const [active, setActive] = useState(isPanelKey(requested) ? requested : 'workspace');

  return (
    <>
      <PageHead title="Settings" />
      <div className="px-4 md:px-6">
        <Tabs items={PANELS} active={active} onChange={setActive} />
      </div>
      <div className="px-4 md:px-6 py-5">
        {active === 'workspace' ? <WorkspacePanel /> : null}
        {active === 'members' ? <MembersPanel /> : null}
        {active === 'billing' ? <BillingPanel /> : null}
        {active === 'profile' ? <ProfilePanel /> : null}
      </div>
    </>
  );
}
