// Typed HTTP failures the auth layer raises. A handler converts these into a
// bare Response carrying the status; any other thrown value is an unexpected
// 500. Keeping the status on the error lets middleware short-circuit by throwing
// rather than threading Response objects back up the chain.

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** The request was malformed (e.g. a fingerprint that is not 64 hex chars). */
export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'BadRequestError';
  }
}

/** The caller is not authorized: no verifiable identity or no active session. */
export class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}
