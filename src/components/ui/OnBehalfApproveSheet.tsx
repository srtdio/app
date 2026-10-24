// The one on-behalf approve sheet: the post screen's "Approve on their behalf",
// the Pipeline MoveSheet and a board drop on Approved all open it for an
// agency-side role. A picker of the workspace's approvers (active client-role
// members), each "Name (Brand)", the first preselected; Cancel and the green
// Approve. The post title is deliberately not shown. The view is hookless so it
// is unit tested by walking the tree; the wrapper holds the picked approver.
// Tokens only, so light and dark match; motion is the host Sheet's translateY.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Sheet } from '@/components/ui/Sheet';
import { isClient } from '@/components/pages/pcs/roles';

export const ON_BEHALF_TITLE = 'Approve on their behalf?';
export const ON_BEHALF_FIELD = 'Approving on behalf of';

/** One approver in the picker. */
export interface ApproverOption {
  userId: string;
  name: string;
}

/** "Name (Brand)"; the name alone when the brand is not known. */
export function approverLabel(name: string, brand: string | null | undefined): string {
  const b = brand?.trim() ?? '';
  return b !== '' ? `${name} (${b})` : name;
}

/** Active client-role members with a display name, in member order. Pure. */
export function toApproverOptions(
  members: readonly { user_id: string; role: string | null; active: boolean }[],
  names: ReadonlyMap<string, string>,
): ApproverOption[] {
  return members
    .filter((m) => m.active && isClient(m.role))
    .flatMap((m) => {
      const name = names.get(m.user_id)?.trim() ?? '';
      return name !== '' ? [{ userId: m.user_id, name }] : [];
    });
}

export interface OnBehalfApproveViewProps {
  open: boolean;
  approvers: readonly ApproverOption[];
  brand: string | null;
  /** The picked approver's user id ('' with no approvers). */
  selected: string;
  onSelect: (userId: string) => void;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  /** The picked approver's id, or undefined when the workspace lists none. */
  onConfirm: (onBehalfOf: string | undefined) => void;
}

export function OnBehalfApproveView(props: OnBehalfApproveViewProps): ReactElement {
  const options: SelectOption[] = props.approvers.map((a) => ({
    value: a.userId,
    label: approverLabel(a.name, props.brand),
  }));
  return (
    <Sheet
      open={props.open}
      onClose={props.onCancel}
      title={ON_BEHALF_TITLE}
      busy={props.busy}
      footer={
        <div className="flex w-full gap-2">
          <Button
            variant="ghost"
            className="flex-1"
            data-on-behalf-cancel=""
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="success"
            className="flex-1"
            data-on-behalf-approve=""
            disabled={props.busy}
            onClick={() => props.onConfirm(props.selected !== '' ? props.selected : undefined)}
          >
            Approve
          </Button>
        </div>
      }
    >
      <div data-on-behalf-sheet="" className="flex flex-col gap-1.5">
        <span className="block text-legacy-sm font-medium text-fg">{ON_BEHALF_FIELD}</span>
        <Select
          value={props.selected}
          options={options}
          onChange={props.onSelect}
          label={ON_BEHALF_FIELD}
          disabled={props.busy || options.length === 0}
        />
        {props.error !== undefined && props.error !== null ? (
          <p role="alert" data-on-behalf-error="" className="mt-1 text-legacy-sm text-bad">
            {props.error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

export type OnBehalfApproveSheetProps = Omit<OnBehalfApproveViewProps, 'selected' | 'onSelect'>;

/** The stateful sheet: preselects the first approver each time it opens. */
export function OnBehalfApproveSheet(props: OnBehalfApproveSheetProps): ReactElement {
  const first = props.approvers[0]?.userId ?? '';
  const [selected, setSelected] = useState(first);
  useEffect(() => {
    if (props.open) setSelected(first);
  }, [props.open, first]);
  return <OnBehalfApproveView {...props} selected={selected} onSelect={setSelected} />;
}
