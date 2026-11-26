/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — B1 (gate r2): compose the fetch, never replace it; refresh only the
 * header that carried the placeholder; install nothing without a placeholder. Supersedes ADDENDUM-1's
 * `RED.headers.freshAuthorizationFetch.spec.ts` (same destination).
 *
 * Measured: `getOpenAIConfig` already sets `configOptions.fetch = createFetch({ directEndpoint, reverseProxyUrl, ssrfAgents,
 * redirect: 'error' | undefined })` (packages/api/src/endpoints/openai/config.ts:297-303; createFetch generators.ts:25) and
 * that object becomes the run's `configuration` (agents/initialize.ts:1612-1613). The runtime SDK is openai 6.49.0
 * (@librechat/agents 3.7.7 → @langchain/openai 1.5.8), `ClientOptions.fetch` (client.d.ts:98), called on EVERY attempt
 * through `fetchWithTimeout` → `this.fetch.call(undefined, url, fetchOptions)` (client.js:531/552), retries included
 * (`retryRequest` → `makeRequest`).
 *
 * Contract: `resolveConfigHeaders({ llmConfig, user, body, tokenSource })`:
 *  - for every header whose ORIGINAL value contains `{{LIBRECHAT_OPENID_ACCESS_TOKEN}}` or `{{LIBRECHAT_OPENID_TOKEN}}`,
 *    remember `{ key, template }`;
 *  - if that set is non-empty and a `tokenSource` is given: `const inner = configuration.fetch ?? globalThis.fetch;
 *    configuration.fetch = async (input, init) => inner(input, { ...init, headers: <init.headers with each remembered key
 *    set to template.replace(placeholder, await tokenSource.current())> })` — `input` and every other `init` field
 *    (method, body, signal, redirect, dispatcher, duplex) pass through unchanged;
 *  - otherwise `configuration.fetch` and the headers are left exactly as they were.
 * Gate r3 S1: `init.headers` is a `Headers` instance in R19, R19b and R19d (openai 6.49.0 `buildHeaders` returns one), so a
 * spread-based wrapper that drops the other headers fails here.
 * Neuters: replace the fetch → R19b RED; always set `Authorization` → R19d RED; install unconditionally → R19c RED.
 */
import type { RunLLMConfig } from '~/types';
import { resolveConfigHeaders } from './headers';

const T0_S = Math.floor(Date.UTC(2026, 10, 25, 13, 41, 55) / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (exp: number) => `${b64({ alg: 'none' })}.${b64({ sub: 'kc-sub-0001', exp })}.sig`;
type Cfg = {
  defaultHeaders: Record<string, string>;
  fetch?: (input: unknown, init?: RequestInit) => Promise<unknown>;
};
const mk = (defaultHeaders: Record<string, string>, fetch?: Cfg['fetch']) =>
  ({
    configuration: { defaultHeaders, ...(fetch ? { fetch } : {}) },
  }) as unknown as Partial<RunLLMConfig> & { configuration: Cfg };
const stale = fakeJwt(T0_S + 300);
const fresh = fakeJwt(T0_S + 900);
const user = {
  id: 'user-1',
  provider: 'openid',
  openidId: 'kc-sub-0001',
  federatedTokens: { access_token: stale, expires_at: T0_S + 300 },
};
const PLACEHOLDER = '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}';

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — per-request Authorization, composed over the existing fetch', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => (T0_S + 5) * 1000);
  });
  afterEach(() => nowSpy.mockRestore());

  it('R19 — with a token source and a placeholder header, a fetch is installed that injects a FRESH bearer per request', async () => {
    const tokenSource = { current: jest.fn(async () => fresh) };
    const llmConfig = mk({
      Authorization: `Bearer ${PLACEHOLDER}`,
      'X-Session-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
    resolveConfigHeaders({
      llmConfig,
      user,
      body: { conversationId: 'fa78a7d3' },
      tokenSource,
    } as never);
    expect(llmConfig.configuration.defaultHeaders['X-Session-Id']).toBe('fa78a7d3');
    expect(typeof llmConfig.configuration.fetch).toBe('function');
    const inner = jest.fn(async () => ({ ok: true }));
    const saved = globalThis.fetch;
    globalThis.fetch = inner as unknown as typeof fetch;
    try {
      await llmConfig.configuration.fetch!('https://bff.test/v1/chat/completions', {
        method: 'POST',
        headers: new Headers({ Authorization: `Bearer ${stale}` }),
      });
    } finally {
      globalThis.fetch = saved;
    }
    expect(tokenSource.current).toHaveBeenCalledTimes(1);
    expect(
      new Headers(((inner.mock.calls[0] as unknown[])[1] as RequestInit).headers).get(
        'authorization',
      ),
    ).toBe(`Bearer ${fresh}`);
  });

  it('R19b — an EXISTING configuration.fetch (the SSRF-protected one) is still the one called, with the fresh bearer and the init otherwise unchanged', async () => {
    const existing = jest.fn(async () => ({ ok: true, via: 'existing' }));
    const tokenSource = { current: jest.fn(async () => fresh) };
    const llmConfig = mk(
      { Authorization: `Bearer ${PLACEHOLDER}` },
      existing as unknown as Cfg['fetch'],
    );
    const globalSpy = jest.fn(async () => ({ ok: true, via: 'global' }));
    const saved = globalThis.fetch;
    globalThis.fetch = globalSpy as unknown as typeof fetch;
    try {
      resolveConfigHeaders({ llmConfig, user, body: {}, tokenSource } as never);
      expect(typeof llmConfig.configuration.fetch).toBe('function');
      const controller = new AbortController();
      const dispatcher = { tag: 'ssrf-agent' };
      const init = {
        method: 'POST',
        body: '{"stream":true}',
        signal: controller.signal,
        redirect: 'error' as RequestRedirect,
        dispatcher,
        duplex: 'half',
        headers: new Headers({
          Authorization: `Bearer ${stale}`,
          'content-type': 'application/json',
        }),
      } as RequestInit & { dispatcher: unknown; duplex: string };
      const out = await llmConfig.configuration.fetch!(
        'https://bff.test/v1/chat/completions',
        init,
      );
      expect(out).toEqual({ ok: true, via: 'existing' });
      expect(existing).toHaveBeenCalledTimes(1);
      expect(globalSpy).not.toHaveBeenCalled();
      const [input, passed] = existing.mock.calls[0] as unknown as [
        unknown,
        RequestInit & { dispatcher: unknown; duplex: string },
      ];
      expect(input).toBe('https://bff.test/v1/chat/completions');
      expect(passed.method).toBe('POST');
      expect(passed.body).toBe('{"stream":true}');
      expect(passed.signal).toBe(controller.signal);
      expect(passed.redirect).toBe('error');
      expect(passed.dispatcher).toBe(dispatcher);
      expect(passed.duplex).toBe('half');
      const headers = new Headers(passed.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${fresh}`);
      expect(headers.get('content-type')).toBe('application/json');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('R19c — without an OpenID placeholder nothing is installed: fetch and headers are exactly as before', () => {
    const existing = jest.fn();
    const tokenSource = { current: jest.fn(async () => fresh) };
    const llmConfig = mk(
      {
        Authorization: 'Bearer sk-endpoint-key',
        'X-Session-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      },
      existing as unknown as Cfg['fetch'],
    );
    resolveConfigHeaders({ llmConfig, user, body: { conversationId: 'c1' }, tokenSource } as never);
    expect(llmConfig.configuration.fetch).toBe(existing);
    expect(llmConfig.configuration.defaultHeaders).toEqual({
      Authorization: 'Bearer sk-endpoint-key',
      'X-Session-Id': 'c1',
    });
    expect(tokenSource.current).not.toHaveBeenCalled();
    const noFetch = mk({ Authorization: 'Bearer sk-endpoint-key' });
    resolveConfigHeaders({ llmConfig: noFetch, user, body: {}, tokenSource } as never);
    expect(noFetch.configuration.fetch).toBeUndefined();
  });

  it('R19d — the placeholder in another header refreshes ONLY that header, with its own prefix; Authorization (the endpoint key) is untouched', async () => {
    const tokenSource = { current: jest.fn(async () => fresh) };
    const llmConfig = mk({
      Authorization: 'Bearer sk-endpoint-key',
      'X-Token': `Token ${PLACEHOLDER}`,
    });
    const inner = jest.fn(async () => ({ ok: true }));
    const saved = globalThis.fetch;
    globalThis.fetch = inner as unknown as typeof fetch;
    try {
      resolveConfigHeaders({ llmConfig, user, body: {}, tokenSource } as never);
      expect(typeof llmConfig.configuration.fetch).toBe('function');
      await llmConfig.configuration.fetch!('https://bff.test/v1/chat/completions', {
        method: 'POST',
        headers: new Headers({
          Authorization: 'Bearer sk-endpoint-key',
          'X-Token': `Token ${stale}`,
        }),
      });
    } finally {
      globalThis.fetch = saved;
    }
    const headers = new Headers(((inner.mock.calls[0] as unknown[])[1] as RequestInit).headers);
    expect(headers.get('x-token')).toBe(`Token ${fresh}`);
    expect(headers.get('authorization')).toBe('Bearer sk-endpoint-key');
  });

  it('R19e — resolving the same configuration twice neither loses the templates nor wraps the fetch twice (A5)', async () => {
    const tokenSource = { current: jest.fn(async () => fresh) };
    const existing = jest.fn(async () => ({ ok: true }));
    const llmConfig = mk(
      { Authorization: `Bearer ${PLACEHOLDER}` },
      existing as unknown as Cfg['fetch'],
    );
    resolveConfigHeaders({ llmConfig, user, body: {}, tokenSource } as never);
    const wrapped = llmConfig.configuration.fetch;
    resolveConfigHeaders({ llmConfig, user, body: {}, tokenSource } as never);
    expect(llmConfig.configuration.fetch).toBe(wrapped);
    await llmConfig.configuration.fetch!('https://bff.test/v1/chat/completions', {
      method: 'POST',
      headers: new Headers({ Authorization: `Bearer ${stale}` }),
    });
    expect(existing).toHaveBeenCalledTimes(1);
    expect(tokenSource.current).toHaveBeenCalledTimes(1);
    const passed = (existing.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(passed.headers).get('authorization')).toBe(`Bearer ${fresh}`);
  });

  it('R19f — a first resolution without a token source keeps the templates for a later call that has one (A5)', async () => {
    const tokenSource = { current: jest.fn(async () => fresh) };
    const llmConfig = mk({ Authorization: `Bearer ${PLACEHOLDER}` });
    resolveConfigHeaders({ llmConfig, user, body: {} } as never);
    expect(llmConfig.configuration.fetch).toBeUndefined();
    resolveConfigHeaders({ llmConfig, user, body: {}, tokenSource } as never);
    expect(typeof llmConfig.configuration.fetch).toBe('function');
  });

  it('R19g — a header template that also carries another placeholder keeps it resolved, and only the token part is refreshed', async () => {
    const tokenSource = { current: jest.fn(async () => fresh) };
    const llmConfig = mk({ 'X-Mixed': `${PLACEHOLDER};conv={{LIBRECHAT_BODY_CONVERSATIONID}}` });
    const inner = jest.fn(async () => ({ ok: true }));
    const saved = globalThis.fetch;
    globalThis.fetch = inner as unknown as typeof fetch;
    try {
      resolveConfigHeaders({
        llmConfig,
        user,
        body: { conversationId: 'c9' },
        tokenSource,
      } as never);
      await llmConfig.configuration.fetch!('https://bff.test/v1/chat/completions', {
        method: 'POST',
        headers: new Headers(),
      });
    } finally {
      globalThis.fetch = saved;
    }
    const passed = (inner.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(passed.headers).get('x-mixed')).toBe(`${fresh};conv=c9`);
  });

  it('R19h — a source that yields no token leaves the request headers as the SDK built them', async () => {
    const tokenSource = { current: jest.fn(async () => undefined) };
    const llmConfig = mk({ Authorization: `Bearer ${PLACEHOLDER}` });
    const inner = jest.fn(async () => ({ ok: true }));
    const saved = globalThis.fetch;
    globalThis.fetch = inner as unknown as typeof fetch;
    try {
      resolveConfigHeaders({ llmConfig, user, body: {}, tokenSource } as never);
      await llmConfig.configuration.fetch!('https://bff.test/v1/chat/completions', {
        method: 'POST',
        headers: new Headers({ Authorization: 'Bearer from-the-sdk' }),
      });
    } finally {
      globalThis.fetch = saved;
    }
    const passed = (inner.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(passed.headers).get('authorization')).toBe('Bearer from-the-sdk');
  });
});
