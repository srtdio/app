// Result constructors shared by the workspace operations. The Result and
// DomainError shapes are owned by @srtdio/rpc so a workspace caller can branch
// on the same { ok } discriminant it already uses for the SECURITY DEFINER
// proc wrappers. Domain failures never throw; transport / unexpected failures
// collapse to the 'unknown' code.

import type { DomainErrorCode, Result } from '@srtdio/rpc';

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(code: DomainErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}
