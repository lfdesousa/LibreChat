const {
  runWithRequestAccessToken,
  getRequestAccessToken,
  getRequestTokenSource,
  getRequestSub,
} = require('./requestContext');

describe('AuditTraceConversations/requestContext', () => {
  it('returns undefined outside any run() — the background/no-request default', async () => {
    await expect(getRequestAccessToken()).resolves.toBeUndefined();
    expect(getRequestSub()).toBeUndefined();
  });

  it('exposes the token/sub inside run() (the token is awaitable: a source is asked per call)', async () => {
    await runWithRequestAccessToken({ accessToken: 'tok-1', sub: 'user-1' }, async () => {
      await expect(getRequestAccessToken()).resolves.toBe('tok-1');
      expect(getRequestSub()).toBe('user-1');
    });
  });

  it('asks a token SOURCE on every call, so a later call can carry a newer token', async () => {
    const source = { current: jest.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new') };
    await runWithRequestAccessToken({ source, sub: 'user-5' }, async () => {
      await expect(getRequestAccessToken()).resolves.toBe('old');
      await expect(getRequestAccessToken()).resolves.toBe('new');
      expect(getRequestTokenSource()).toBe(source);
    });
    expect(source.current).toHaveBeenCalledTimes(2);
  });

  it('propagates across await boundaries inside run()', async () => {
    await runWithRequestAccessToken({ accessToken: 'tok-2', sub: 'user-2' }, async () => {
      await Promise.resolve();
      await expect(getRequestAccessToken()).resolves.toBe('tok-2');
      await new Promise((resolve) => setImmediate(resolve));
      await expect(getRequestAccessToken()).resolves.toBe('tok-2');
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
      await expect(getRequestAccessToken()).resolves.toBe('tok-3');
    });
    await expect(getRequestAccessToken()).resolves.toBeUndefined();
  });

  it('a context with no accessToken (e.g. no OIDC console login) reads as undefined', async () => {
    await runWithRequestAccessToken({ sub: 'user-4' }, async () => {
      await expect(getRequestAccessToken()).resolves.toBeUndefined();
      expect(getRequestTokenSource()).toBeUndefined();
      expect(getRequestSub()).toBe('user-4');
    });
  });
});
