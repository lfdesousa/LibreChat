/* CONSOLE-AUDIT-EVIDENCE WU-D — the one data path of the evidence dialog */
import { useQuery } from '@tanstack/react-query';
import { request, apiBaseUrl } from 'librechat-data-provider';
import type { QueryObserverResult } from '@tanstack/react-query';
import type { TEvidenceV1 } from './types';

/**
 * The chain's shared id predicate (orchestrator, BFF, fork API route, and here): `.` and `..`
 * refused, no slash, 1 to 255 characters. No `m` flag, so a trailing line feed fails.
 */
const MESSAGE_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,255}$/;

export const EVIDENCE_QUERY_KEY = 'auditEvidence';

/**
 * The fork API route for one message's evidence, or `null` when the id fails the predicate (the
 * caller then requests nothing). The UI reaches evidence ONLY through `/api/audittrace/evidence`;
 * the fork API forwards the session token to the BFF. Nothing here names the BFF or the server.
 */
export const evidenceMessagePath = (messageId: string): string | null =>
  MESSAGE_ID_PATTERN.test(messageId)
    ? `${apiBaseUrl()}/api/audittrace/evidence/messages/${encodeURIComponent(messageId)}`
    : null;

/**
 * Evidence for one assistant message. No retry on a refusal (a 401/403/404 is an answer, not a
 * glitch), no refetch, and nothing outlives react-query's in-memory cache: the fork renders, never
 * stores.
 */
export const useEvidenceQuery = (
  messageId: string,
  enabled: boolean,
): QueryObserverResult<TEvidenceV1> => {
  const path = evidenceMessagePath(messageId);
  return useQuery<TEvidenceV1>(
    [EVIDENCE_QUERY_KEY, messageId],
    () => request.get(path as string) as Promise<TEvidenceV1>,
    {
      enabled: enabled && path !== null,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  );
};
