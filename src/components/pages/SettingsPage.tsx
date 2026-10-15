import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead } from '@/components/shell/PageHead';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { MembersPanel } from '@/components/pages/settings/MembersPanel';
import { WorkspaceSettingsPanel } from '@/components/pages/settings/WorkspaceSettingsPanel';
import { ProfileSettingsPanel } from '@/components/settings/ProfileSettingsPanel';

const PANELS: TabItem[] = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'members', label: 'Members' },
  { key: 'profile', label: 'Profile' },
];

function isPanelKey(value: string | null): value is string {
  return value !== null && PANELS.some((panel) => panel.key === value);
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
        {active === 'workspace' ? <WorkspaceSettingsPanel /> : null}
        {active === 'members' ? <MembersPanel /> : null}
        {active === 'profile' ? <ProfileSettingsPanel /> : null}
      </div>
    </>
  );
}
