// Settings > Profile: change your @username. Same rules and live check as
// onboarding (src/lib/onboarding.ts); saves on its own with username_set, so it
// never touches the name, role or photo form around it. Old mentions keep
// pointing at the same person: the body stores the user id, not the text.

import { useEffect, useState, type ReactElement } from 'react';
import { usernameSet } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { normalizeUsernameInput, usernameFormat } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { checkUsername } from '@/lib/username-check';

type Check = 'idle' | 'checking' | 'free' | 'taken' | 'error';

export function UsernameField({
  current,
  onSaved,
}: {
  /** The saved username; null when the person has none yet. */
  current: string | null;
  onSaved: () => void;
}): ReactElement {
  const newTrace = useNewTrace();
  const [value, setValue] = useState(current ?? '');
  const [edited, setEdited] = useState(false);
  const [check, setCheck] = useState<Check>('idle');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A fresh profile read (another device, or after saving) fills the field
  // unless the person is mid-edit.
  useEffect(() => {
    if (!edited) setValue(current ?? '');
  }, [current, edited]);

  const format = usernameFormat(value);
  const unchanged = value === (current ?? '');

  useEffect(() => {
    if (unchanged || format !== 'ok') {
      setCheck('idle');
      return;
    }
    setCheck('checking');
    let cancelled = false;
    const id = window.setTimeout(() => {
      void checkUsername(value, newTrace).then((result) => {
        if (!cancelled) setCheck(result);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [value, format, unchanged, newTrace]);

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    const res = await usernameSet(supabase, { p_username: value, p_trace_id: newTrace() });
    setSaving(false);
    if (!res.ok) {
      if (res.error.message.includes('username_taken')) {
        setCheck('taken');
        return;
      }
      logger.error('settings username save failed', { error: res.error.message });
      setMessage("Couldn't save your username. Try again.");
      return;
    }
    setEdited(false);
    setMessage('Username saved.');
    onSaved();
  }

  const hint = unchanged
    ? 'People @mention you with this.'
    : format === 'empty'
      ? 'Pick a username.'
      : format === 'invalid'
        ? 'Use up to 20 lowercase letters, numbers, dots or underscores.'
        : format === 'reserved'
          ? `@${value} is reserved. Try another.`
          : check === 'checking'
            ? 'Checking...'
            : check === 'taken'
              ? `@${value} is taken. Try another.`
              : check === 'error'
                ? `We'll check @${value} when you save.`
                : `@${value} is yours.`;
  const tone =
    !unchanged && check === 'free'
      ? 'text-good'
      : format === 'invalid' || format === 'reserved' || check === 'taken'
        ? 'text-warn'
        : 'text-fg-3';
  const canSave =
    !unchanged && format === 'ok' && (check === 'free' || check === 'error') && !saving;

  return (
    <div>
      <label htmlFor="settings-username" className="mb-1.5 block text-base font-medium">
        Username
      </label>
      <div className="flex gap-2">
        <div className="flex h-11 min-w-0 flex-1 items-center rounded-lg border border-border bg-panel-2 pl-3 focus-within:border-accent-line focus-within:ring-2 focus-within:ring-accent-soft">
          <span className="text-base text-fg-3">@</span>
          <input
            id="settings-username"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              setEdited(true);
              setMessage(null);
              setValue(normalizeUsernameInput(event.target.value));
            }}
            className="h-full min-w-0 flex-1 bg-transparent pl-0.5 pr-3 text-input text-fg outline-none md:text-base"
          />
        </div>
        {!unchanged ? (
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {saving ? 'Saving' : 'Save'}
          </Button>
        ) : null}
      </div>
      <p className={cn('mt-1.5 text-sm', message !== null ? 'text-fg-2' : tone)} aria-live="polite">
        {message ?? hint}
      </p>
    </div>
  );
}
