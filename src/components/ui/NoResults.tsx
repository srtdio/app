import { Button } from '@/components/ui/Button';
import { ICON_SIZE, IconSearch } from '@/components/ui/icons';
import { EmptyState } from '@/components/ui/EmptyState';

interface NoResultsProps {
  /** The live search text; blank or missing means no search is active. */
  query?: string;
  filtersActive: boolean;
  onClear: () => void;
}

/** The copy for a zero-result search or filter, by what is narrowing the list. */
export function noResultsCopy(
  query: string | undefined,
  filtersActive: boolean,
): { title: string; action: string } {
  const q = query?.trim() ?? '';
  if (q !== '' && filtersActive) {
    return { title: 'Try another word or fewer filters.', action: 'Clear all' };
  }
  if (q !== '') return { title: `Try another word for "${q}".`, action: 'Clear search' };
  return { title: 'Try fewer filters.', action: 'Clear filters' };
}

/** The one zero-result state for every search and filter. */
export function NoResults({ query, filtersActive, onClear }: NoResultsProps) {
  const copy = noResultsCopy(query, filtersActive);
  return (
    <EmptyState
      compact
      icon={<IconSearch size={ICON_SIZE.control} />}
      title={copy.title}
      action={
        <Button variant="secondary" onClick={onClear}>
          {copy.action}
        </Button>
      }
    />
  );
}
