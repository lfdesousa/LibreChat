/**
 * The `audittrace.evidence.v1` response, as far as the dialog reads it. Every field is optional
 * on purpose: the contract grows by additive keys only, and the dialog must render whatever
 * subset arrives without inventing a value. Nothing here types image bytes, because the contract
 * carries none.
 */
export type TEvidenceInputMediaItem = {
  kind?: string;
  status?: string;
  media_type?: string;
  bytes?: number;
  sha256?: string;
};

export type TEvidenceToolCall = {
  id?: string;
  tool_name?: string;
  granted_scope?: string;
  duration_ms?: number | null;
  error?: string | null;
};

export type TEvidenceSourceItem = {
  source_ref?: string;
  id?: string;
  visibility?: { tier?: string; owner_is_caller?: boolean | null };
};

export type TEvidenceServiceReader = {
  role?: string;
  purpose?: string;
  basis?: string;
};

export type TEvidenceV1 = {
  contract?: string;
  lookup?: { by?: string; value?: string; candidates?: number };
  interaction?: {
    id?: number;
    trace_id?: string;
    model?: string;
    timestamp?: string;
    duration_ms?: number | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    status?: string;
    failure_class?: string | null;
    input_media?: { count?: number; items?: TEvidenceInputMediaItem[] } | null;
  };
  integrity?: { content_hash?: string | null; recomputed?: string | null };
  tool_calls?: TEvidenceToolCall[];
  sources?: { status?: string; items?: TEvidenceSourceItem[] };
  visibility?: {
    answer?: {
      api_readers?: string[];
      owner_is_caller?: boolean;
      service_readers?: TEvidenceServiceReader[] | string;
      operator_access?: string;
    };
  };
};
