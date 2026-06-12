import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconLink } from '@/components/ui/icons';
import { isValidLinkUrl, type LinkOutcome } from '@/lib/asset-upload';

interface AddLinkSheetProps {
  open: boolean;
  onClose: () => void;
  /** Commit: POST {url, name} to the worker's /links route, reporting the outcome. */
  onSubmit: (url: string, name: string) => Promise<LinkOutcome>;
  /** Toast sink (the page toast queue). */
  onToast: (message: string) => void;
  /** Called once after a link is added, to refresh the grid. */
  onAdded: () => void;
}

/**
 * The Add link sheet: a Link field (https:// placeholder, url input mode) and a
 * mandatory Name field. Submit stays disabled until the url parses and starts
 * with http(s):// and the name is non-empty after trim. Validation copy appears
 * inline once a field has been touched. On success it toasts "Added {name}",
 * refreshes the grid, and closes; on failure it surfaces the mapped error. All
 * elements use theme tokens so light and dark match; targets are at least 44px.
 */
export function AddLinkSheet({ open, onClose, onSubmit, onToast, onAdded }: AddLinkSheetProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Clear the fields whenever the sheet closes so it always opens empty.
  useEffect(() => {
    if (!open) {
      setUrl('');
      setName('');
      setUrlTouched(false);
      setNameTouched(false);
      setSubmitting(false);
    }
  }, [open]);

  const urlValid = isValidLinkUrl(url);
  const nameValid = name.trim() !== '';
  const canSubmit = urlValid && nameValid && !submitting;
  const showUrlError = urlTouched && !urlValid;
  const showNameError = nameTouched && !nameValid;

  async function submit(): Promise<void> {
    if (!urlValid || !nameValid) {
      setUrlTouched(true);
      setNameTouched(true);
      return;
    }
    if (submitting) return;
    const display = name.trim();
    setSubmitting(true);
    const outcome = await onSubmit(url, name);
    setSubmitting(false);
    if (outcome.ok) {
      onToast(`Added ${display}`);
      onAdded();
      onClose();
    } else {
      onToast(outcome.message);
    }
  }

  const footer = (
    <span className="ml-auto flex gap-2.5">
      <Button variant="ghost" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
        <IconLink size={16} />
        {submitting ? 'Adding' : 'Add link'}
      </Button>
    </span>
  );

  return (
    <Sheet open={open} onClose={onClose} title="Add link" footer={footer}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">Link</span>
          <Input
            type="url"
            inputMode="url"
            placeholder="https://..."
            value={url}
            autoFocus
            aria-invalid={showUrlError}
            disabled={submitting}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => setUrlTouched(true)}
          />
          {showUrlError ? (
            <span className="text-xs text-bad">Enter a full link starting with https://</span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">Name</span>
          <Input
            placeholder="What should this link be called?"
            value={name}
            aria-invalid={showNameError}
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setNameTouched(true)}
          />
          {showNameError ? <span className="text-xs text-bad">The link needs a name</span> : null}
        </label>
      </div>
    </Sheet>
  );
}
