import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { IconAssets, IconBriefs, IconPlus } from '@/components/ui/icons';
import { dispatchSorted } from '@/lib/events';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
];

export function BriefsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');

  return (
    <>
      <PageHead
        title="Briefs"
        actions={
          <>
            <IconButton label="Assets" onClick={() => navigate('/assets')}>
              <IconAssets />
            </IconButton>
            <Button variant="primary" onClick={() => dispatchSorted('sorted:create-brief')}>
              <IconPlus size={16} />
              New brief
            </Button>
          </>
        }
      />

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">0 open</div>

      <div className="px-4 md:px-6 mt-3 flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            selected={filter === item.key}
            onClick={() => setFilter(item.key)}
          />
        ))}
      </div>

      <EmptyState
        icon={<IconBriefs size={24} />}
        title="No briefs yet"
        description="Briefs from clients will show up here."
      />
    </>
  );
}
