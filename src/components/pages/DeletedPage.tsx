import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { IconTrash } from '@/components/ui/icons';

export function DeletedPage() {
  return (
    <>
      <PageHead title="Recently deleted" />
      <EmptyState
        icon={<IconTrash size={24} />}
        title="Nothing here"
        description="Recently deleted items will appear here for a while before they are removed for good."
      />
    </>
  );
}
