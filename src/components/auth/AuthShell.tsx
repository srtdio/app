import type { ReactNode } from 'react';

/**
 * Centered auth card on the radial-gradient background from the locked
 * reference, rebuilt with the PR A design tokens (var(--accent-soft),
 * var(--bg), panel/border colors) instead of the reference's inline CSS.
 *
 * Rendered outside AppLayout: no sidebar, topbar, or bottom tabs.
 */
interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="min-h-full w-full grid place-items-center px-4 py-10 bg-bg bg-[radial-gradient(circle_at_50%_-10%,var(--accent-soft),transparent_55%)]">
      <div className="w-full max-w-[400px]">
        <div className="rounded-2xl border border-border bg-panel p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(0,0,0,0.12)]">
          <div className="mb-6">
            <div className="text-lg font-semibold tracking-tight">{title}</div>
            <p className="mt-1 text-sm text-fg-2">{subtitle}</p>
          </div>
          {children}
        </div>
        <div className="mt-4 text-center text-sm text-fg-2">{footer}</div>
      </div>
    </div>
  );
}
