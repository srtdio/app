import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';

interface ComposerProps {
  onSend: (text: string) => void;
}

/**
 * Plain-text message composer: a Textarea and a 44px send Button. Enter sends,
 * Shift+Enter inserts a newline. Attachments, mentions, and voice notes are out
 * of scope for this PR, so no inert affordances are rendered.
 */
export function Composer({ onSend }: ComposerProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();

  function submit(): void {
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setText('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-border bg-panel p-3">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        aria-label="Message"
      />
      <Button variant="primary" size="lg" onClick={submit} disabled={trimmed.length === 0}>
        Send
      </Button>
    </div>
  );
}
