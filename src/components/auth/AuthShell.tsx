import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PlanBackdrop } from '@/components/auth/PlanBackdrop';
import { Wordmark } from '@/components/home/Wordmark';

/**
 * Centered auth card over a blurred Plan month (or, with backdrop off, the
 * radial accent-soft gradient). The srtd. wordmark links home: HomeGate shows
 * the home page signed out and sends a signed-in person to Pipeline.
 *
 * Rendered outside AppLayout: no sidebar, topbar, or bottom tabs.
 */
interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
  backdrop?: boolean;
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  wide = false,
  backdrop = true,
}: AuthShellProps) {
  return (
    <div
      className={
        backdrop
          ? 'relative min-h-full w-full grid place-items-center overflow-hidden px-4 py-10 bg-bg'
          : 'min-h-full w-full grid place-items-center px-4 py-10 bg-bg bg-[radial-gradient(circle_at_50%_-10%,var(--accent-soft),transparent_55%)]'
      }
    >
      {backdrop ? <PlanBackdrop /> : null}
      <div
        data-auth-card=""
        className={`relative z-10 flex w-full flex-col gap-6 rounded-2xl border border-border bg-panel p-6 shadow-[var(--shadow-card)] md:p-10 ${wide ? 'max-w-3xl' : 'max-w-[440px]'}`}
      >
        <div className="flex flex-col items-center text-center">
          <Link
            to="/"
            aria-label="srtd home"
            data-auth-home-link=""
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&_.mark]:h-[26px] [&_.mark]:w-auto md:[&_.mark]:h-[30px] [&_.mark-dot]:fill-accent"
          >
            <Wordmark />
          </Link>
          <div className="mt-4 text-3xl font-semibold tracking-tight [text-wrap:balance]">
            {title}
          </div>
          <p className="mt-1 text-base text-fg-2 [text-wrap:balance]">{subtitle}</p>
        </div>
        {children}
        {footer === null || footer === undefined ? null : (
          <div className="border-t border-border pt-2 text-center text-base text-fg-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
