// The office Worker: one request in, one response out. The runner creates a
// fresh Worker per parse and terminates it when the answer arrives, on its
// time cap, on abort or on error, so nothing is left running.

import { handleOfficeRequest } from './handle';
import type { OfficeRequest } from './types';

interface WorkerScope {
  onmessage: ((event: MessageEvent<OfficeRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  scope.postMessage(handleOfficeRequest(event.data));
};
