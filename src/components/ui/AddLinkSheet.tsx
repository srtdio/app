// The composer's Add link sheet: a small ui/Sheet (floating layer) with a Text
// field (prefilled with the selected text) and a Link field. A default export,
// loaded with React.lazy on the first tap of the format strip's link action.
// Save turns the pair into the stored markup, [text](url), through the shared
// helpers in @srtdio/comments: a bare domain gets https://, any other scheme
// (javascript:, mailto:) is refused. Save is never disabled for "not valid
// yet" (forms rule): a Save with a link that does not normalize shows the
// ErrorNote and puts focus back on the Link field. Enter in a field saves.
// Pure render: no listeners, no network. Tokens only, so light and dark match.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { linkMarkup, normalizeLinkUrl } from '@srtdio/comments';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Sheet, SheetActions } from '@/components/ui/Sheet';

/** The line under the Link field after a Save with a link that does not normalize. */
export const ADD_LINK_ERROR = "Couldn't add link. Use a web address.";

/** The markup a Save emits, or null while the link does not normalize. Pure. */
export function addLinkMarkup(text: string, link: string): string | null {
  const url = normalizeLinkUrl(link);
  return url === null ? null : linkMarkup(text, url);
}

export default function AddLinkSheet(props: {
  open: boolean;
  initialText: string;
  onCancel: () => void;
  onSave: (markup: string) => void;
}): ReactElement {
  const { open, initialText, onCancel, onSave } = props;
  const [text, setText] = useState(initialText);
  const [link, setLink] = useState('');
  const [attempted, setAttempted] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const formId = `${ids}-form`;
  const errorId = `${ids}-error`;

  // Each open starts from the caller's text, an empty link and no error.
  useEffect(() => {
    if (!open) return;
    setText(initialText);
    setLink('');
    setAttempted(false);
  }, [open, initialText]);

  const markup = addLinkMarkup(text, link);
  const showError = attempted && markup === null;
  const textPrefilled = initialText.trim() !== '';

  function save(): void {
    if (markup === null) {
      setAttempted(true);
      linkRef.current?.focus();
      return;
    }
    onSave(markup);
  }

  const footer = (
    <SheetActions
      cancel={
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      }
      primary={
        <Button variant="primary" type="submit" form={formId} data-add-link-save="">
          Save
        </Button>
      }
    />
  );

  return (
    <Sheet open={open} onClose={onCancel} title="Add link" footer={footer}>
      {/* A form so Enter in a field saves; the footer's Save is its submit
          button through the form attribute. noValidate: the ErrorNote says
          what is wrong, never the browser's own bubble. */}
      <form
        id={formId}
        noValidate
        data-add-link=""
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Text">
          {(id) => (
            <Input
              id={id}
              name="link-text"
              data-add-link-text=""
              autoComplete="off"
              value={text}
              autoFocus={!textPrefilled}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-col gap-2">
          <Field label="Link">
            {(id) => (
              <Input
                ref={linkRef}
                id={id}
                type="url"
                name="link-url"
                data-add-link-url=""
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="done"
                value={link}
                autoFocus={textPrefilled}
                aria-invalid={showError}
                aria-describedby={showError ? errorId : undefined}
                onChange={(event) => setLink(event.target.value)}
              />
            )}
          </Field>
          {showError ? (
            <ErrorNote>
              <span id={errorId}>{ADD_LINK_ERROR}</span>
            </ErrorNote>
          ) : null}
        </div>
      </form>
    </Sheet>
  );
}
