// The per-member action surface, built on the existing Sheet primitive (no new
// overlay). Shows the member's avatar / name / email / role and the single
// danger action that starts the remove-confirm flow. Kept presentational: the
// panel owns open/close and the confirm dialog.

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { roleLabel } from './members-data';
import type { MemberEntry } from './members-data';

interface MemberActionSheetProps {
  member: MemberEntry | null;
  open: boolean;
  onClose: () => void;
  onRemove: (member: MemberEntry) => void;
}

export function MemberActionSheet({ member, open, onClose, onRemove }: MemberActionSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Member">
      {member !== null ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Avatar
              name={member.displayName}
              {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
              size="xl"
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">{member.displayName}</div>
              {member.email !== null ? (
                <div className="truncate text-xs text-fg-3">{member.email}</div>
              ) : null}
              <div className="mt-1 text-xs text-fg-2">{roleLabel(member.role)}</div>
            </div>
          </div>
          <Button size="lg" variant="danger" className="w-full" onClick={() => onRemove(member)}>
            Remove from workspace
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}
