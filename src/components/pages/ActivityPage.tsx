import { useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { IconActivity } from '@/components/ui/icons';

const STATE_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'snoozed', label: 'Snoozed' },
];

const SCOPE_CHIPS = [
  { key: 'everything', label: 'Everything' },
  { key: 'posts', label: 'Posts' },
  { key: 'briefs', label: 'Briefs' },
  { key: 'people', label: 'People' },
  { key: 'groups', label: 'Groups' },
  { key: 'clients', label: 'Clients' },
];

export function ActivityPage() {
  const [state, setState] = useState('all');
  const [scope, setScope] = useState('everything');

  return (
    <>
      <PageHead title="Activity" />

      <div className="px-4 md:px-6 pt-3 flex flex-wrap gap-2">
        {STATE_CHIPS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            selected={state === item.key}
            onClick={() => setState(item.key)}
          />
        ))}
      </div>

      <div className="px-4 md:px-6 mt-2 flex flex-wrap gap-2">
        {SCOPE_CHIPS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            selected={scope === item.key}
            onClick={() => setScope(item.key)}
          />
        ))}
      </div>

      <EmptyState
        icon={<IconActivity size={24} />}
        title="You are all caught up"
        description="Activity across posts, briefs and people will appear here."
      />
    </>
  );
}
