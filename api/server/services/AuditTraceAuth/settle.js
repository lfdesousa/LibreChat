/**
 * Promise adapters for express-session's callback-only `reload` / `save`. A promise-returning
 * implementation (a test double, a future store) settles the same way as its callback.
 */

/**
 * @param {{reload?: Function}|undefined} session
 * @returns {Promise<void>} resolves when the session was re-read from the store; rejects when it is gone
 */
function reloadSession(session) {
  if (typeof session?.reload !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const result = session.reload((err) => (err ? reject(err) : resolve()));
    if (typeof result?.then === 'function') {
      result.then(() => resolve(), reject);
    }
  });
}

/**
 * @param {{save?: Function}|undefined} session
 * @returns {Promise<void>} resolves when the session record was written to the store
 */
function saveSession(session) {
  if (typeof session?.save !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const result = session.save((err) => (err ? reject(err) : resolve()));
    if (typeof result?.then === 'function') {
      result.then(() => resolve(), reject);
    }
  });
}

module.exports = { reloadSession, saveSession };
