/**
 * AC-7: the terminal path names a sign-in failure to the user (logged by code, emitted with code +
 * text), and leaves every other error to the caller's existing handling. Neuter: swallow the error
 * (return true without emitting) -> the emit assertion goes RED.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { logger } = require('@librechat/data-schemas');
const { handleSovereignTerminalFailure } = require('../terminalFailure');
const { SovereignSessionError } = require('../SovereignSessionError');
const { messageForSovereignFailure } = require('../sessionFailureMessages');

const manager = () => ({ emitError: jest.fn(async () => undefined) });

describe('AuditTraceAuth/terminalFailure', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    'sovereign_session_expired',
    'sovereign_sso_session_ended',
    'sovereign_refresh_token_rejected',
    'sovereign_refresh_failed',
  ])(
    '%s: logged by code and emitted to the client with the code and its own text',
    async (code) => {
      const m = manager();
      const error = new SovereignSessionError({ code, status: 401 });
      const handled = await handleSovereignTerminalFailure({
        error,
        streamId: 'stream-1',
        jobCreatedAt: 1234,
        manager: m,
      });
      expect(handled).toBe(true);
      expect(m.emitError).toHaveBeenCalledWith(
        'stream-1',
        `${messageForSovereignFailure(code).text} (${code})`,
        1234,
      );
      expect(logger.error).toHaveBeenCalledWith(
        `[ResumableAgentController] Terminal persistence refused (${code}) for stream-1`,
      );
    },
  );

  it('leaves any other error to the caller: nothing logged here, nothing emitted', async () => {
    const m = manager();
    const handled = await handleSovereignTerminalFailure({
      error: new Error('Generation failed'),
      streamId: 'stream-2',
      jobCreatedAt: 1,
      manager: m,
    });
    expect(handled).toBe(false);
    expect(m.emitError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a failing emit is logged but never masks the failure: still reported as handled', async () => {
    const m = { emitError: jest.fn(async () => Promise.reject(new Error('transport down'))) };
    const handled = await handleSovereignTerminalFailure({
      error: new SovereignSessionError({ code: 'sovereign_refresh_failed', status: 502 }),
      streamId: 'stream-3',
      jobCreatedAt: undefined,
      manager: m,
    });
    expect(handled).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
