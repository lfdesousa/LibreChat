import type { TEvidenceServiceReader, TEvidenceV1 } from '~/data-provider/Evidence';
import type { TranslationKeys } from '~/hooks';

/** The service role name the orchestrator serves when the chart cannot name the real reader. */
const OPERATOR_MANAGED = 'operator-managed';

/**
 * Exactly three integrity outcomes are ever shown. Anything that is not literally `match` or
 * `mismatch` (the contract's `unavailable`, but also a null, a number or a value a later contract
 * version adds) is "not recorded for this row type": the dialog never says verified or failed
 * about something it cannot read.
 */
export function integrityLabelKey(recomputed: unknown): TranslationKeys {
  if (recomputed === 'match') {
    return 'com_evidence_integrity_match';
  }
  if (recomputed === 'mismatch') {
    return 'com_evidence_integrity_mismatch';
  }
  return 'com_evidence_integrity_unavailable';
}

/** A plain message for a refused or failed lookup. Never shows any part of a response body. */
export function errorMessageKey(error: unknown): TranslationKeys {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 404) {
    return 'com_evidence_error_not_found';
  }
  if (status === 403) {
    return 'com_evidence_error_forbidden';
  }
  if (status === 401) {
    return 'com_evidence_error_unauthorized';
  }
  return 'com_evidence_error_generic';
}

export type TServiceReaderLine =
  | { kind: 'unverified' }
  | { kind: 'named'; role: string; purpose: string };

/**
 * One line per service reader. `service_readers` may be the list the orchestrator derives from the
 * chart grants, or the single value `operator-managed` (served as an object with basis
 * `unverified`, or, defensively, as a bare string): those render as "unverified", never as a role.
 * An entry that does not name both a role and a purpose cannot be stated, so it is "unverified" too.
 */
export function serviceReaderLines(
  serviceReaders: TEvidenceServiceReader[] | string | undefined,
): TServiceReaderLine[] {
  if (serviceReaders === undefined || serviceReaders === null) {
    return [];
  }
  if (typeof serviceReaders === 'string') {
    return [{ kind: 'unverified' }];
  }
  if (!Array.isArray(serviceReaders)) {
    return [{ kind: 'unverified' }];
  }
  let unverifiedSeen = false;
  const lines: TServiceReaderLine[] = [];
  for (const reader of serviceReaders) {
    const named =
      typeof reader?.role === 'string' &&
      typeof reader?.purpose === 'string' &&
      reader.role !== OPERATOR_MANAGED &&
      reader.basis !== 'unverified';
    if (named) {
      lines.push({ kind: 'named', role: reader.role as string, purpose: reader.purpose as string });
    } else if (!unverifiedSeen) {
      unverifiedSeen = true;
      lines.push({ kind: 'unverified' });
    }
  }
  return lines;
}

/** The recorded images of the question, as the contract serves them (type, size, hash: no bytes). */
export function imageItems(data: TEvidenceV1) {
  const items = data.interaction?.input_media?.items;
  return Array.isArray(items) ? items : [];
}
