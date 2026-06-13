import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { IconChat, IconUser } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { createGroupChannel, startDmChannel } from '@/components/chat/chat-actions';
import { MemberPicker } from '@/components/chat/MemberPicker';
import { excludeMembers } from '@/components/chat/member-picker';
import { useWorkspaceMembers } from '@/components/chat/use-workspace-members';

interface NewChatSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  currentUserId: string;
  /** Called with the ensured DM channel id; the parent refreshes and opens it. */
  onDmReady: (channelId: string) => void;
  /** Called after a group is created; the parent refreshes the channel list. */
  onGroupCreated: () => void;
}

type Mode = 'choose' | 'dm' | 'group';

/**
 * The "New chat" entry point: choose between a new DM or a new group, then pick
 * the people. DM ensures the one-to-one channel and opens it; group creates the
 * channel with all chosen members in a single call. Domain failures surface
 * inline and never throw.
 */
export function NewChatSheet(props: NewChatSheetProps): ReactElement {
  const newTrace = useNewTrace();
  const members = useWorkspaceMembers(props.workspaceId);

  const [mode, setMode] = useState<Mode>('choose');
  const [peerId, setPeerId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to a clean state every time the sheet opens.
  useEffect(() => {
    if (props.open) {
      setMode('choose');
      setPeerId(null);
      setName('');
      setSelectedIds([]);
      setBusy(false);
      setError(null);
    }
  }, [props.open]);

  // The current user can never be their own DM peer or a group co-member of self.
  const options = excludeMembers(members.options, [props.currentUserId]);

  function toggleSelected(userId: string): void {
    setSelectedIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  async function submitDm(): Promise<void> {
    if (peerId === null || busy) return;
    setBusy(true);
    setError(null);
    const failure = await startDmChannel(
      supabase,
      { workspaceId: props.workspaceId, peerUserId: peerId, traceId: newTrace() },
      props.onDmReady,
    );
    setBusy(false);
    if (failure !== null) setError(failure.message);
  }

  async function submitGroup(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || selectedIds.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const failure = await createGroupChannel(
      supabase,
      {
        workspaceId: props.workspaceId,
        name: trimmed,
        memberUserIds: selectedIds,
        traceId: newTrace(),
      },
      () => props.onGroupCreated(),
    );
    setBusy(false);
    if (failure !== null) setError(failure.message);
  }

  const title = mode === 'group' ? 'New group' : mode === 'dm' ? 'New direct message' : 'New chat';
  const errorBanner =
    error !== null ? (
      <div role="alert" className="mb-3 rounded-md border border-bad px-3 py-2 text-sm text-bad">
        {error}
      </div>
    ) : null;

  return (
    <Sheet open={props.open} onClose={props.onClose} title={title} footer={footer()}>
      {errorBanner}
      {body()}
    </Sheet>
  );

  function footer(): ReactElement | undefined {
    if (mode === 'choose') return undefined;
    if (mode === 'dm') {
      return (
        <>
          <Button size="lg" disabled={busy} onClick={() => setMode('choose')}>
            Back
          </Button>
          <Button
            size="lg"
            variant="primary"
            className="ml-auto"
            disabled={peerId === null || busy}
            onClick={() => void submitDm()}
          >
            {busy ? 'Starting' : 'Start chat'}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button size="lg" disabled={busy} onClick={() => setMode('choose')}>
          Back
        </Button>
        <Button
          size="lg"
          variant="primary"
          className="ml-auto"
          disabled={name.trim().length === 0 || selectedIds.length === 0 || busy}
          onClick={() => void submitGroup()}
        >
          {busy ? 'Creating' : 'Create group'}
        </Button>
      </>
    );
  }

  function body(): ReactElement {
    if (mode === 'choose') {
      return (
        <div className="flex flex-col gap-2">
          <Button size="lg" className="justify-start" onClick={() => setMode('dm')}>
            <IconUser size={18} />
            New direct message
          </Button>
          <Button size="lg" className="justify-start" onClick={() => setMode('group')}>
            <IconChat size={18} />
            New group
          </Button>
        </div>
      );
    }
    if (mode === 'dm') {
      return (
        <MemberPicker
          options={options}
          selectedIds={peerId !== null ? [peerId] : []}
          onToggle={(id) => setPeerId((prev) => (prev === id ? null : id))}
          loading={members.loading}
          error={members.error}
          emptyLabel="No one else is in this workspace yet."
        />
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <Field label="Group name" htmlFor="new-group-name" required>
          <Input
            id="new-group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Campaign team"
            aria-label="Group name"
          />
        </Field>
        <div>
          <p className="mb-1.5 text-sm font-medium">Members</p>
          <MemberPicker
            options={options}
            selectedIds={selectedIds}
            onToggle={toggleSelected}
            loading={members.loading}
            error={members.error}
            emptyLabel="No one else is in this workspace yet."
          />
        </div>
      </div>
    );
  }
}
