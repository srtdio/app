// A local error boundary: one broken piece of UI (a message's attachment area,
// the file viewer) renders its own small fallback and is reported to the
// existing Sentry project, while everything around it keeps working. The app's
// only other boundary is the Sentry one at the root, which replaces the whole
// screen; this keeps a single bad message from blanking the thread.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { captureException } from '@/lib/sentry';

export interface ErrorBoundaryProps {
  /** Names the boundary in the Sentry report ("chat-attachment", "file-viewer"). */
  name: string;
  /** What renders in place of the children after they threw. */
  fallback: ReactNode;
  children: ReactNode;
  /** Optional extra context for the report (never message text or file contents). */
  context?: Record<string, unknown>;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    captureException(error, {
      boundary: this.props.name,
      component_stack: info.componentStack ?? '',
      ...this.props.context,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
