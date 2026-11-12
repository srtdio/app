// A light stand-in for chat's Composer in the Plan item screen's render tests
// (vi.mock('@/components/chat/Composer', ...)): a textarea and a Send key
// that hand the typed text to onSend, starting from (and writing back) the
// box's draft in the real draft store, so a put-back draft shows after a
// remount. The real Composer (picker, tray, uploads) is tested on its own.
// Every mounted box's latest props are kept for assertions (mentions, tray).

import { useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { ComposerProps } from '@/components/chat/Composer';
import { clearDraft, getDraft, setDraft } from '@/lib/chat/drafts';

/** The latest props of every mounted box, by its channel id. */
export const composerProps = new Map<string, ComposerProps>();

export function Composer(props: ComposerProps): ReactElement {
  const channelId = props.channelId ?? '';
  composerProps.set(channelId, props);
  const [value, setValue] = useState(() => getDraft(channelId).text);
  const formRef = useRef<HTMLFormElement>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (value.trim() === '') return;
    props.onSend(value, [], [], null, []);
    clearDraft(channelId);
    setValue('');
  };
  return (
    <form ref={formRef} data-composer-stub={channelId} onSubmit={submit}>
      {props.quoteStrip ?? null}
      <textarea
        ref={(el) => {
          if (props.inputRef !== undefined) props.inputRef.current = el;
        }}
        aria-label="Message"
        placeholder={props.placeholder}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setDraft(channelId, {
            text: event.target.value,
            caret: event.target.value.length,
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          formRef.current?.requestSubmit();
        }}
      />
      <button type="submit" aria-label="Send" disabled={props.disabled} />
    </form>
  );
}
