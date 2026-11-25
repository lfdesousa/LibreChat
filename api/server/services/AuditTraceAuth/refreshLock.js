/**
 * The process-wide per-session lock the token source and `refreshController` share
 * (valid for the 1-replica, in-process session store the console deploys). Keyed on
 * `req.sessionID`: one refresh grant per session at a time, so a rotated refresh token
 * is never presented twice.
 *
 * Non-reentrant by construction: nothing inside `fn` may wait on the token source of the
 * same session (the critical section is the grant, the session write and the save only).
 * Released on EVERY path: the table entry is removed in a `finally` once the last waiter of
 * the key has settled, so `isLocked` is false after a success, a throw or a rejection.
 */

/** @type {Map<string, Promise<void>>} the settled-marker of the newest holder or waiter per key */
const tails = new Map();

const noop = () => undefined;

/**
 * @template T
 * @param {string|undefined} key - `req.sessionID`; without one there is nothing to share, `fn` runs directly
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withSessionLock(key, fn) {
  if (!key) {
    return fn();
  }
  const previous = tails.get(key);
  const run = (async () => {
    if (previous) {
      await previous;
    }
    return fn();
  })();
  const tail = run.then(noop, noop);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    await tail;
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  }
}

/**
 * Test-only: whether a holder or a waiter exists for the session.
 * @param {string} key
 * @returns {boolean}
 */
function isLocked(key) {
  return tails.has(key);
}

module.exports = { withSessionLock, isLocked };
