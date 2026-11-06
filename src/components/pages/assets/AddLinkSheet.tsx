import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Input } from '@/components/ui/Input';
import { Sheet, SheetActions } from '@/components/ui/Sheet';
import { ICON_SIZE, IconLink } from '@/components/ui/icons';
import { isValidLinkUrl, type LinkOutcome } from '@/lib/asset-upload';
import type { AssetToast } from '@/components/pages/assets/AssetActionSheet';

/** The Sheet's discard confirm for a typed link. */
const ADD_LINK_DISCARD = {
  title: 'Discard this link?',
  message: 'The link and name you typed will be lost.',
};

/** Whether the Add link sheet holds typed input. Pure. */
export function addLinkDirty(url: string, name: string): boolean {
  return url !== '' || name !== '';
}

interface AddLinkSheetProps {
  open: boolean;
  onClose: () => void;
  /** Commit: POST {url, name} to the worker's /links route, reporting the outcome. */
  onSubmit: (url: string, name: string) => Promise<LinkOutcome>;
  /** Toast sink (ui/toast): failures pass 'error' (the bad tone); successes stay neutral. */
  onToast: AssetToast;
  /** Called once after a link is added, to refresh the grid. */
  onAdded: () => void;
}

/**
 * The Add link sheet: a Link field (https:// placeholder, url input mode) and a
 * mandatory Name field, inside a form so Enter submits. Add link is never
 * disabled for "not valid yet": a tap shows the lines (a url that does not
 * start with http(s)://, an empty name) and focuses the first bad field; a
 * field also says so once it loses focus. On success it toasts "Added {name}",
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

  const ids = useId();
  const formId = `${ids}-form`;
  const urlId = `${ids}-url`;
  const nameId = `${ids}-name`;
  const urlValid = isValidLinkUrl(url);
  const nameValid = name.trim() !== '';
  // Anything typed is unsaved work: X, Escape, the backdrop and system Back ask first.
  const dirty = addLinkDirty(url, name);
  const showUrlError = urlTouched && !urlValid;
  const showNameError = nameTouched && !nameValid;

  // Add link is never disabled for "not valid yet": a tap (or Enter) shows
  // both lines and focuses the first bad field. Busy is the only hold.
  async function submit(): Promise<void> {
    if (submitting) return;
    if (!urlValid || !nameValid) {
      setUrlTouched(true);
      setNameTouched(true);
      document.getElementById(!urlValid ? urlId : nameId)?.focus();
      return;
    }
    const display = name.trim();
    setSubmitting(true);
    const outcome = await onSubmit(url, name);
    setSubmitting(false);
    if (outcome.ok) {
      onToast(`Added ${display}`);
      onAdded();
      onClose();
    } else {
      onToast(outcome.message, 'error');
    }
  }

  const footer = (
    <SheetActions
      cancel={
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
      }
      primary={
        <Button variant="primary" type="submit" form={formId} busy={submitting}>
          {submitting ? null : <IconLink size={ICON_SIZE.inline} />}
          Add link
        </Button>
      }
    />
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add link"
      footer={footer}
      dirty={dirty}
      discard={ADD_LINK_DISCARD}
      busy={submitting}
      busyLabel="Adding…"
    >
      {/* A form so Enter in either field submits; the footer's Add link is
          its submit button through the form attribute. noValidate: the lines
          below say what is wrong, never the browser's own bubble. */}
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={urlId} className="text-base font-medium text-fg-2">
            Link
          </label>
          <Input
            id={urlId}
            type="url"
            name="url"
            autoComplete="url"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="https://…"
            value={url}
            autoFocus
            aria-invalid={showUrlError}
            aria-describedby={showUrlError ? `${urlId}-error` : undefined}
            disabled={submitting}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => setUrlTouched(true)}
          />
          {showUrlError ? (
            <ErrorNote>
              <span id={`${urlId}-error`}>Enter a full link starting with https://</span>
            </ErrorNote>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-base font-medium text-fg-2">
            Name
          </label>
          <Input
            id={nameId}
            name="link-name"
            autoComplete="off"
            placeholder="What should this link be called?"
            value={name}
            aria-invalid={showNameError}
            aria-describedby={showNameError ? `${nameId}-error` : undefined}
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setNameTouched(true)}
          />
          {showNameError ? (
            <ErrorNote>
              <span id={`${nameId}-error`}>The link needs a name</span>
            </ErrorNote>
          ) : null}
        </div>
      </form>
    </Sheet>
  );
}
