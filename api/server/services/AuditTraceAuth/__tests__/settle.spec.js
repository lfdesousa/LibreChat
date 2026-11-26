/** The promise adapters over express-session's callback-only reload/save settle like their callback. */
const { reloadSession, saveSession } = require('../settle');

describe.each([
  ['reloadSession', reloadSession, 'reload'],
  ['saveSession', saveSession, 'save'],
])('AuditTraceAuth/settle %s', (_name, adapter, method) => {
  it('resolves when the callback reports no error', async () => {
    await expect(adapter({ [method]: (cb) => cb() })).resolves.toBeUndefined();
  });

  it('rejects with the callback error', async () => {
    const error = new Error('store down');
    await expect(adapter({ [method]: (cb) => cb(error) })).rejects.toBe(error);
  });

  it('settles like a promise-returning implementation, in both directions', async () => {
    await expect(adapter({ [method]: () => Promise.resolve() })).resolves.toBeUndefined();
    const error = new Error('rejected');
    await expect(adapter({ [method]: () => Promise.reject(error) })).rejects.toBe(error);
  });

  it('resolves for a session that has no such method (nothing to re-read or write)', async () => {
    await expect(adapter({})).resolves.toBeUndefined();
    await expect(adapter(undefined)).resolves.toBeUndefined();
  });
});
