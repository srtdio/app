import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';

interface ComposerProps {
  /** Sends the trimmed text; resolves when the SDK send settles. */
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
}

/**
 * Plain-text composer: a Textarea plus a 44px (size lg) send Button. No
 * attachments, mentions, or voice notes; those are later PRs and are omitted
 * entirely rather than shown inert.
 */
export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const canSend = !props.disabled && text.trim() !== '';

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    const pending = text;
    setText('');
    try {
      await props.onSend(pending);
    } catch {
      // Restore the draft so a failed send is not silently lost.
      setText(pending);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 border-t border-border bg-panel px-4 py-3"
    >
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Write a message"
        rows={1}
        className="min-h-[44px]"
      />
      <Button type="submit" variant="primary" size="lg" disabled={!canSend}>
        Send
      </Button>
    </form>
  );
}
