// The root error boundary. React only, so the boot render does not wait for
// the Sentry SDK; a crash still replaces the screen with ErrorFallback and is
// reported through src/lib/sentry (queued until Sentry has loaded).

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { captureException } from '@/lib/sentry';

export function ErrorFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-bg text-fg">
      <span className="text-base">Something went wrong. Refresh to try again.</span>
    </main>
  );
}

interface BootErrorBoundaryProps {
  children: ReactNode;
}

interface BootErrorBoundaryState {
  failed: boolean;
}

export class BootErrorBoundary extends Component<BootErrorBoundaryProps, BootErrorBoundaryState> {
  override state: BootErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): BootErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    captureException(error, { boundary: 'root', component_stack: info.componentStack ?? '' });
  }

  override render(): ReactNode {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
