import { mark } from '@/lib/perf-marks';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead } from '@/components/shell/PageHead';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { MembersPanel } from '@/components/pages/settings/MembersPanel';
import { StoragePanel } from '@/components/pages/settings/StoragePanel';
import { WorkspaceSettingsPanel } from '@/components/pages/settings/WorkspaceSettingsPanel';
import { ProfileSettingsPanel } from '@/components/settings/ProfileSettingsPanel';
import { storageUsedLine } from '@/components/storage/storage-usage';
import { useStorageWarning } from '@/components/storage/useStorageWarning';
import { ActionRow } from '@/components/ui/ActionRow';
import { ICON_SIZE, IconAssets } from '@/components/ui/icons';

const PANELS: TabItem[] = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'members', label: 'Members' },
  { key: 'storage', label: 'Storage' },
  { key: 'profile', label: 'Profile' },
];

function isPanelKey(value: string | null): value is string {
  return value !== null && PANELS.some((panel) => panel.key === value);
}

export function SettingsPage() {
  // ?panel= is the active tab: a tap writes it (replace, so Back leaves
  // Settings instead of stepping through tabs) and a later ?panel= change while
  // mounted (a link, the induction tour) switches the tab.
  const [params, setParams] = useSearchParams();
  const requested = params.get('panel');
  const active = isPanelKey(requested) ? requested : 'workspace';
  const setActive = useCallback(
    (key: string) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('panel', key);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  // One usage read for the Storage row and the Storage panel.
  const { usage } = useStorageWarning();
  mark('settings:mount');

  return (
    <>
      <PageHead title="Settings" />
      <div className="px-4 md:px-6">
        <Tabs items={PANELS} active={active} onChange={setActive} />
      </div>
      <div className="px-4 md:px-6 py-5">
        {active === 'workspace' ? (
          <div className="flex flex-col gap-6">
            <WorkspaceSettingsPanel />
            <div className="-mx-3 max-w-[544px]">
              <ActionRow
                icon={<IconAssets size={ICON_SIZE.nav} />}
                label="Storage"
                {...(usage !== null ? { sub: storageUsedLine(usage.usedBytes) } : {})}
                onClick={() => setActive('storage')}
                chevron
              />
            </div>
          </div>
        ) : null}
        {active === 'members' ? <MembersPanel /> : null}
        {active === 'storage' ? <StoragePanel usage={usage} /> : null}
        {active === 'profile' ? <ProfileSettingsPanel /> : null}
      </div>
    </>
  );
}
