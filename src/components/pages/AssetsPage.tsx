import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { IconAssets, IconUpload } from '@/components/ui/icons';

export function AssetsPage() {
  return (
    <>
      <PageHead
        title="Assets"
        actions={
          <Button variant="primary">
            <IconUpload size={16} />
            Upload
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-3 text-sm text-fg-3">
        <span className="font-mono">/</span>
      </div>

      <EmptyState
        icon={<IconAssets size={24} />}
        title="No assets yet"
        description="Upload images and files to use them in posts."
        action={
          <Button variant="primary">
            <IconUpload size={16} />
            Upload
          </Button>
        }
      />
    </>
  );
}
