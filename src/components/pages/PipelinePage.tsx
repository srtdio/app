import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { PageHead } from '@/components/shell/PageHead';
import { Tabs } from '@/components/shell/Tabs';
import type { TabItem } from '@/components/shell/Tabs';
import { IconAssets, IconCheck, IconSort, IconX } from '@/components/ui/icons';
import { dispatchSorted } from '@/lib/events';

const STAGE_TABS: TabItem[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'review', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'parked', label: 'Parked' },
  { key: 'rejected', label: 'Rejected' },
];

const COLUMNS = ['Draft', 'Review', 'Approved', 'Parked', 'Rejected'];

interface OnboardingStep {
  key: string;
  label: string;
  action: string;
  run: () => void;
}

export function PipelinePage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState('all');
  const [cardDismissed, setCardDismissed] = useState(false);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});

  const steps: OnboardingStep[] = [
    {
      key: 'post',
      label: 'Create your first post',
      action: 'Create post',
      run: () => dispatchSorted('sorted:create-post'),
    },
    {
      key: 'invite',
      label: 'Invite a teammate',
      action: 'Invite',
      run: () => navigate('/settings?panel=members'),
    },
    {
      key: 'brief',
      label: 'Create your first brief',
      action: 'Create brief',
      run: () => dispatchSorted('sorted:create-brief'),
    },
  ];

  const visibleSteps = steps.filter((step) => skipped[step.key] !== true);
  const showCard = !cardDismissed && visibleSteps.length > 0;

  return (
    <>
      <PageHead
        title="Pipeline"
        actions={
          <>
            <IconButton label="Assets" onClick={() => navigate('/assets')}>
              <IconAssets />
            </IconButton>
            <Button>
              <IconSort size={16} />
              Sort
            </Button>
          </>
        }
      />

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">0 posts</div>

      <div className="px-4 md:px-6 mt-2">
        <Tabs items={STAGE_TABS} active={stage} onChange={setStage} />
      </div>

      <div className="px-4 md:px-6 mt-3 flex flex-wrap gap-2">
        <Chip label="+ Owner" variant="add" />
        <Chip label="+ Bucket" variant="add" />
        <Chip label="+ Date" variant="add" />
      </div>

      {showCard ? (
        <div className="px-4 md:px-6 mt-4">
          <div className="rounded-xl border border-border bg-panel-2 p-4">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Get started</div>
              <span className="ml-auto">
                <IconButton label="Dismiss" onClick={() => setCardDismissed(true)}>
                  <IconX size={16} />
                </IconButton>
              </span>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {visibleSteps.map((step) => (
                <li
                  key={step.key}
                  className="flex items-center gap-3 min-h-[44px] rounded-lg px-2 hover:bg-panel-3 transition-colors"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-fg-3 shrink-0">
                    <IconCheck size={14} />
                  </span>
                  <span className="flex-1 text-sm">{step.label}</span>
                  <Button variant="primary" size="sm" onClick={step.run}>
                    {step.action}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSkipped((prev) => ({ ...prev, [step.key]: true }))}
                  >
                    Skip
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="px-4 md:px-6 py-4 flex gap-3 overflow-x-auto">
        {COLUMNS.map((column) => (
          <div
            key={column}
            className="flex w-[260px] shrink-0 flex-col rounded-xl border border-border bg-panel-2"
          >
            <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
              <span className="text-sm font-medium">{column}</span>
              <span className="ml-auto text-xs text-fg-3 tabular-nums">0</span>
            </div>
            <div className="flex items-center justify-center min-h-[160px] px-3 py-6 text-sm text-fg-3">
              No posts
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
