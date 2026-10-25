// The two "talk to us" rows shared by the workspace switcher, the full sheet
// and Settings > Storage. Presentational: each caller owns its sheets.

import { ActionRow } from '@/components/ui/ActionRow';
import { IconAt, IconCalendar, ICON_SIZE } from '@/components/ui/icons';
import { SUPPORT_EMAIL } from '@/lib/support';

export function SupportRows(props: { onContact: () => void; onBook: () => void }) {
  return (
    <>
      <ActionRow
        icon={<IconAt size={ICON_SIZE.tray} />}
        label="Contact us"
        sub={SUPPORT_EMAIL}
        onClick={props.onContact}
        chevron
      />
      <ActionRow
        icon={<IconCalendar size={ICON_SIZE.tray} />}
        label="Book a call"
        sub="Pick a time, we send a Meet link"
        onClick={props.onBook}
        chevron
      />
    </>
  );
}
