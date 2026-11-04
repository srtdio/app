import { useId } from 'react';
import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  /** The control's id. When absent, Field generates one (useId). */
  htmlFor?: string;
  /** Alias of htmlFor. */
  id?: string;
  required?: boolean;
  hint?: string;
  /**
   * The control. Pass a function to receive the label's id and put it on the
   * control (a render prop: `(id) =>` the control with `id={id}`), so the
   * label always names it.
   */
  children: ReactNode | ((id: string) => ReactNode);
}

/**
 * The id a Field's label points at: `htmlFor`, else `id`, else the generated
 * one. Pure so the linking rule unit-tests without a DOM.
 */
export function fieldControlId(
  htmlFor: string | undefined,
  id: string | undefined,
  generated: string,
): string {
  return htmlFor ?? id ?? generated;
}

export function Field({ label, htmlFor, id, required = false, hint, children }: FieldProps) {
  const generated = useId();
  const controlId = fieldControlId(htmlFor, id, generated);
  // A plain-node child with no id given (an attachments list, a read-only
  // line) has no control to point at, so the label names the group only.
  const linked = htmlFor !== undefined || id !== undefined || typeof children === 'function';
  return (
    <div>
      <label
        {...(linked ? { htmlFor: controlId } : {})}
        className="block text-base font-medium mb-1.5"
      >
        {label}
        {required ? <span className="text-bad ml-0.5">*</span> : null}
      </label>
      {typeof children === 'function' ? children(controlId) : children}
      {hint !== undefined ? <p className="text-sm text-fg-3 mt-1.5">{hint}</p> : null}
    </div>
  );
}
