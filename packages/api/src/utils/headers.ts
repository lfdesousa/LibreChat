import type { AnthropicClientOptions } from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import type { RequestBody, RunLLMConfig } from '~/types';
import { resolveHeaders } from './env';

/**
 * The media type of a `Content-Type` header — the lowercased `type/subtype` pair with any
 * parameters stripped, or `''` when the header is absent or empty.
 *
 * Substring-matching the raw header is wrong in both directions. A `text/plain;
 * boundary=text/event-stream` value contains the SSE type without being one, and a
 * `TEXT/EVENT-STREAM` value is one without containing it in the expected case. Callers
 * classifying a response by its type must compare against this, not the raw header.
 */
export function mediaTypeEssence(header: string | null | undefined): string {
  if (!header) {
    return '';
  }
  return (header.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** Comma-unions two header values (deduped, trimmed), e.g. `anthropic-beta`. */
function unionCsv(a: string, b: string): string {
  const values = [a, b]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(values)).join(',');
}

/**
 * Merges two header maps, with `override` winning on key collisions. Matching is
 * case-insensitive (HTTP header names are), so an `override` key replaces any
 * case variant from `base` rather than leaving both names in the output (which
 * clients may collapse, breaking auth or protocol headers); the `override`
 * casing is kept. The `anthropic-beta` header is special-cased: values from both
 * sides are comma-unioned (deduped) so a custom beta coexists with
 * provider-managed betas instead of clobbering them.
 *
 * Used both to layer endpoint headers over global (`endpoints.all`) headers and
 * to attach admin-configured custom headers beneath provider-managed headers
 * (auth/version/beta), so the provider integration's own headers always win.
 *
 * @returns the merged map, or `undefined` when neither side has any headers.
 */
export function mergeHeaders(
  base?: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: Record<string, string> = { ...(base ?? {}) };
  if (!override) {
    return merged;
  }

  const baseKeyByLower = new Map<string, string>(
    Object.keys(merged).map((key) => [key.toLowerCase(), key]),
  );

  for (const [key, value] of Object.entries(override)) {
    const lower = key.toLowerCase();
    const existingKey = baseKeyByLower.get(lower);
    const nextValue =
      lower === 'anthropic-beta' && existingKey != null
        ? unionCsv(merged[existingKey], value)
        : value;

    if (existingKey != null && existingKey !== key) {
      delete merged[existingKey];
    }
    merged[key] = nextValue;
    baseKeyByLower.set(lower, key);
  }

  return merged;
}

type DefaultHeadersContainer = { defaultHeaders?: Record<string, string> };

/** An OpenAI-SDK-shaped fetch: the SDK calls `configuration.fetch` once per HTTP attempt (retries included). */
type ConfigurationFetch = (input: unknown, init?: RequestInit) => Promise<unknown>;
type FetchContainer = DefaultHeadersContainer & { fetch?: ConfigurationFetch };

/**
 * A source of an access token that is fresh NOW: awaited once per outbound request, so a run
 * that outlives one token's lifetime keeps sending a valid one.
 */
export interface AccessTokenSource {
  current: () => Promise<string | undefined>;
}

const OPENID_ACCESS_TOKEN_PLACEHOLDERS = [
  '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
  '{{LIBRECHAT_OPENID_TOKEN}}',
] as const;
/** Stands for the token inside a header template that has every OTHER placeholder resolved. */
const FRESH_TOKEN_SENTINEL = '__librechat_fresh_bearer__';

type RefreshableHeader = { key: string; resolvedTemplate: string };

/**
 * The refreshable headers of each resolved header map, recorded from the ORIGINAL templates
 * before resolution replaced them: `resolveOnce` is idempotent, so a second call on the same
 * configuration sees only resolved values and must neither lose these nor wrap the fetch twice.
 */
const refreshableHeadersByMap = new WeakMap<object, RefreshableHeader[]>();
/** Configurations whose `fetch` already carries the per-request bearer. */
const bearerFetchInstalled = new WeakSet<object>();

/**
 * Header maps already resolved by `resolveConfigHeaders`. `resolveConfigHeaders`
 * mutates config objects in place, and the same initialized agent (hence the same
 * nested header objects) can flow through `buildAgentInput` more than once (root +
 * subagent, multiple parents). Resolving twice would run env expansion over values
 * already substituted with user/body data, violating the env-before-user invariant
 * documented in `resolveHeaders`. Tracking resolved maps makes resolution
 * idempotent across reuse. Keyed by object identity (per-request fresh objects), so
 * nothing carries across requests.
 */
const resolvedHeaderMaps = new WeakSet<object>();

/**
 * For every header whose ORIGINAL value carries an OpenID access-token placeholder, the template
 * with every other placeholder resolved and the token left as a sentinel.
 */
function recordRefreshableHeaders(
  headers: Record<string, string>,
  context: {
    user?: Partial<IUser> | { id: string };
    body?: RequestBody;
    customUserVars?: Record<string, string>;
  },
): RefreshableHeader[] {
  const refreshable: RefreshableHeader[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      continue;
    }
    const carriesToken = OPENID_ACCESS_TOKEN_PLACEHOLDERS.some((p) => value.includes(p));
    if (!carriesToken) {
      continue;
    }
    const withSentinel = OPENID_ACCESS_TOKEN_PLACEHOLDERS.reduce(
      (acc, placeholder) => acc.split(placeholder).join(FRESH_TOKEN_SENTINEL),
      value,
    );
    const resolved = resolveHeaders({
      headers: { [key]: withSentinel },
      ...context,
      stripUnresolved: true,
    });
    refreshable.push({ key, resolvedTemplate: resolved[key] ?? withSentinel });
  }
  return refreshable;
}

/**
 * Composes `configuration.fetch` (the OpenAI SDK calls it for every attempt, streaming and
 * retries included) so each outbound request carries a token that is fresh now in exactly the
 * headers that carried the placeholder, each with its own prefix. The existing fetch (the
 * SSRF-protected one) stays the one that is called with the init otherwise unchanged; nothing is
 * installed without a placeholder-carrying header, a source, or twice for one configuration.
 */
function installFreshBearerFetch(
  configuration: FetchContainer,
  tokenSource: AccessTokenSource | undefined,
): void {
  const refreshable =
    (configuration.defaultHeaders && refreshableHeadersByMap.get(configuration.defaultHeaders)) ??
    [];
  if (!tokenSource || refreshable.length === 0 || bearerFetchInstalled.has(configuration)) {
    return;
  }
  const existing = configuration.fetch;
  configuration.fetch = async (input, init) => {
    const token = await tokenSource.current();
    const headers = new Headers(init?.headers);
    if (token) {
      for (const { key, resolvedTemplate } of refreshable) {
        headers.set(key, resolvedTemplate.split(FRESH_TOKEN_SENTINEL).join(token));
      }
    }
    const inner = existing ?? (globalThis.fetch as unknown as ConfigurationFetch);
    return inner(input, { ...init, headers });
  };
  bearerFetchInstalled.add(configuration);
}

/**
 * Resolves placeholder templates in the outbound request headers of a built LLM
 * config, mutating it in place. Handles the OpenAI-compatible
 * `configuration.defaultHeaders` (OpenAI / Azure / custom) and the native
 * Anthropic `clientOptions.defaultHeaders` (including Vertex) carriers. Native
 * Google `customHeaders` are intentionally NOT handled here — they are resolved
 * once at init in `initializeGoogle`, so the provider-managed `Authorization`
 * header (built from a possibly user-provided key) never passes through env
 * expansion.
 *
 * Resolution runs at request time so request-body placeholders (e.g.
 * `{{LIBRECHAT_BODY_CONVERSATIONID}}`) resolve against the live request. It is a
 * no-op for header values without placeholders, and idempotent under config reuse.
 *
 * This is the last resolution pass before the outbound provider request, so any
 * placeholder still unresolved here (missing user context, a user without the
 * configured field) is stripped rather than forwarded as literal template text
 * the upstream could mistake for real user data.
 */
export function resolveConfigHeaders({
  llmConfig,
  user,
  body,
  customUserVars,
  tokenSource,
}: {
  /** Partial: this only reads the three provider header carriers, so
   *  callers with a bare ClientOptions (e.g. auxiliary generations like
   *  titles/activity labels) can resolve headers without assembling a
   *  full run config. */
  llmConfig?: Partial<RunLLMConfig> | null;
  user?: Partial<IUser> | { id: string };
  body?: RequestBody;
  customUserVars?: Record<string, string>;
  /**
   * When given, a header that carried an OpenID access-token placeholder is re-resolved on EVERY
   * outbound request with a token that is fresh now (see `installFreshBearerFetch`).
   */
  tokenSource?: AccessTokenSource;
}): void {
  if (llmConfig == null) {
    return;
  }

  const resolveOnce = (headers: Record<string, string>): Record<string, string> => {
    if (resolvedHeaderMaps.has(headers)) {
      return headers;
    }
    const refreshable = recordRefreshableHeaders(headers, { user, body, customUserVars });
    const resolved = resolveHeaders({ headers, user, body, customUserVars, stripUnresolved: true });
    resolvedHeaderMaps.add(resolved);
    refreshableHeadersByMap.set(resolved, refreshable);
    return resolved;
  };

  const configuration = llmConfig.configuration as FetchContainer | undefined;
  if (configuration?.defaultHeaders != null) {
    configuration.defaultHeaders = resolveOnce(configuration.defaultHeaders);
    installFreshBearerFetch(configuration, tokenSource);
  }

  const clientOptions = (llmConfig as AnthropicClientOptions).clientOptions as
    | DefaultHeadersContainer
    | undefined;
  if (clientOptions?.defaultHeaders != null) {
    clientOptions.defaultHeaders = resolveOnce(clientOptions.defaultHeaders);
  }
}
