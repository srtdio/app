import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHead } from '@/components/shell/PageHead';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { MembersInviteForm } from '@/components/pages/settings/MembersInviteForm';
import { ProfileSettingsPanel } from '@/components/settings/ProfileSettingsPanel';

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

function MembersPanel() {
  return <MembersInviteForm />;
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
        {active === 'profile' ? <ProfileSettingsPanel /> : null}
      </div>
    </>
  );
}
