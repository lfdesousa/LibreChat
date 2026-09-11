const {
  runWithRequestAccessToken,
  getRequestAccessToken,
  getRequestSub,
} = require('./requestContext');

describe('AuditTraceConversations/requestContext', () => {
  it('returns undefined outside any run() — the background/no-request default', () => {
    expect(getRequestAccessToken()).toBeUndefined();
    expect(getRequestSub()).toBeUndefined();
  });

  it('exposes the token/sub to synchronous code inside run()', () => {
    runWithRequestAccessToken({ accessToken: 'tok-1', sub: 'user-1' }, () => {
      expect(getRequestAccessToken()).toBe('tok-1');
      expect(getRequestSub()).toBe('user-1');
    });
  });

  it('propagates across await boundaries inside run()', async () => {
    await runWithRequestAccessToken({ accessToken: 'tok-2', sub: 'user-2' }, async () => {
      await Promise.resolve();
      expect(getRequestAccessToken()).toBe('tok-2');
      await new Promise((resolve) => setImmediate(resolve));
      expect(getRequestAccessToken()).toBe('tok-2');
    });
  });

  it('isolates concurrent contexts from each other', async () => {
    const results = await Promise.all([
      runWithRequestAccessToken({ accessToken: 'tok-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestAccessToken();
      }),
      runWithRequestAccessToken({ accessToken: 'tok-b' }, async () => {
        return getRequestAccessToken();
      }),
    ]);
    expect(results).toEqual(['tok-a', 'tok-b']);
  });

  it('returns undefined again once run() has returned', async () => {
    await runWithRequestAccessToken({ accessToken: 'tok-3' }, async () => {
      expect(getRequestAccessToken()).toBe('tok-3');
    });
    expect(getRequestAccessToken()).toBeUndefined();
  });

  it('a context with no accessToken (e.g. no OIDC console login) reads as undefined', () => {
    runWithRequestAccessToken({ sub: 'user-4' }, () => {
      expect(getRequestAccessToken()).toBeUndefined();
      expect(getRequestSub()).toBe('user-4');
    });
  });
});
