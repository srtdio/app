import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, required = false, hint, children }: FieldProps) {
  return (
    <div>
      <label
        {...(htmlFor !== undefined ? { htmlFor } : {})}
        className="block text-sm font-medium mb-1.5"
      >
        {label}
        {required ? <span className="text-bad ml-0.5">*</span> : null}
      </label>
      {children}
      {hint !== undefined ? <p className="text-[11px] text-fg-3 mt-1.5">{hint}</p> : null}
    </div>
  );
}
