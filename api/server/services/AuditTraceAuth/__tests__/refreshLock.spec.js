/**
 * The per-session lock (CONSOLE-LONG-TURN-TOKEN-REFRESH, ADDENDUM-1 B3 / ADDENDUM-2 A3): serial per
 * key, independent across keys, released on EVERY path. Liveness is proved structurally
 * (`isLocked`, a lock table that is empty afterwards), never by a wall-clock bound.
 */
const { withSessionLock, isLocked } = require('../refreshLock');

/** A promise settled from the outside, so ordering is driven by the test, not by time. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('AuditTraceAuth/refreshLock', () => {
  it('runs holders of one key one at a time, in arrival order', async () => {
    const events = [];
    const gate = deferred();
    const first = withSessionLock('s1', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = withSessionLock('s1', async () => {
      events.push('second:start');
    });
    expect(isLocked('s1')).toBe(true);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(isLocked('s1')).toBe(false);
  });

  it('does not make different sessions wait for each other', async () => {
    const gate = deferred();
    const held = withSessionLock('a', () => gate.promise);
    await expect(withSessionLock('b', async () => 'b-done')).resolves.toBe('b-done');
    expect(isLocked('a')).toBe(true);
    gate.resolve();
    await held;
    expect(isLocked('a')).toBe(false);
    expect(isLocked('b')).toBe(false);
  });

  it('is released when the holder throws, and the next caller acquires it', async () => {
    await expect(
      withSessionLock('s2', async () => {
        throw new Error('grant failed');
      }),
    ).rejects.toThrow('grant failed');
    expect(isLocked('s2')).toBe(false);
    await expect(withSessionLock('s2', async () => 'next')).resolves.toBe('next');
    expect(isLocked('s2')).toBe(false);
  });

  it('a waiter still runs when the holder ahead of it rejects', async () => {
    const gate = deferred();
    const failing = withSessionLock('s3', async () => {
      await gate.promise;
      throw new Error('boom');
    });
    const waiter = withSessionLock('s3', async () => 'ran');
    gate.resolve();
    await expect(failing).rejects.toThrow('boom');
    await expect(waiter).resolves.toBe('ran');
    expect(isLocked('s3')).toBe(false);
  });

  it('without a session id there is nothing to share: fn runs directly and no entry is created', async () => {
    await expect(withSessionLock(undefined, async () => 'direct')).resolves.toBe('direct');
    expect(isLocked(undefined)).toBe(false);
  });
});
