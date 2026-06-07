// Koa-style middleware composition. Folds an ordered list of middlewares into a
// single one so an edge function or worker mounts the whole stack with one call.

import type { Middleware } from './middleware.ts';

/**
 * Fold an ordered list of middlewares into one. Each runs in order and decides
 * whether to invoke the next; the first to throw short-circuits the remainder.
 * With no middlewares the composed handler is just the terminal handler itself.
 * Calling `next()` more than once from a single middleware is a programming
 * error and rejects.
 */
export function compose(...middlewares: readonly Middleware[]): Middleware {
  return (ctx, handler) => {
    let lastIndex = -1;
    const dispatch = (i: number): Promise<Response> => {
      if (i <= lastIndex) {
        return Promise.reject(new Error('next() called multiple times'));
      }
      lastIndex = i;
      const middleware = middlewares[i];
      // Wrap so a middleware (or the handler) that throws synchronously surfaces
      // as a rejected promise, never an exception escaping compose itself.
      try {
        if (!middleware) return Promise.resolve(handler());
        return Promise.resolve(middleware(ctx, () => dispatch(i + 1)));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return dispatch(0);
  };
}
