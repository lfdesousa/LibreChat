import type { TEvidenceV1 } from '~/data-provider/Evidence';
import { imageItems, integrityLabelKey } from './evidenceModel';
import { useLocalize } from '~/hooks';

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5 py-1 sm:flex-row sm:gap-3">
      <dt className="w-44 shrink-0 text-sm text-text-secondary">{label}</dt>
      <dd className="break-all text-sm text-text-primary">{value}</dd>
    </div>
  );
}

const present = (value: unknown): value is string | number =>
  value !== undefined && value !== null && value !== '';

/**
 * The "Reconstruct" tab. Every value is the payload's: a field the payload lacks is a missing row,
 * never a placeholder. Image records are lines (type, size, sha256, a not-stored note) rendered from
 * a fixed set of fields, so nothing else the payload might carry can reach the DOM.
 */
export default function ReconstructTab({ data }: { data: TEvidenceV1 }) {
  const localize = useLocalize();
  const interaction = data.interaction ?? {};
  const candidates = data.lookup?.candidates;
  const images = imageItems(data);
  const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
  const contentHash = data.integrity?.content_hash;

  return (
    <div className="flex flex-col gap-4">
      <dl>
        {present(data.lookup?.value) && (
          <Row label={localize('com_evidence_message_id')} value={data.lookup?.value as string} />
        )}
        {present(interaction.id) && (
          <Row label={localize('com_evidence_audit_record_id')} value={interaction.id as number} />
        )}
        {present(interaction.trace_id) && (
          <Row label={localize('com_evidence_trace_id')} value={interaction.trace_id as string} />
        )}
        {present(interaction.model) && (
          <Row label={localize('com_evidence_model')} value={interaction.model as string} />
        )}
        {present(interaction.timestamp) && (
          <Row label={localize('com_evidence_time')} value={interaction.timestamp as string} />
        )}
        {typeof interaction.duration_ms === 'number' && (
          <Row
            label={localize('com_evidence_duration')}
            value={localize('com_evidence_duration_value', {
              seconds: (interaction.duration_ms / 1000).toFixed(1),
            })}
          />
        )}
        {present(interaction.prompt_tokens) && present(interaction.completion_tokens) && (
          <Row
            label={localize('com_evidence_tokens')}
            value={localize('com_evidence_tokens_value', {
              prompt: interaction.prompt_tokens,
              completion: interaction.completion_tokens,
            })}
          />
        )}
        {present(interaction.status) && (
          <Row label={localize('com_evidence_status')} value={interaction.status as string} />
        )}
      </dl>

      {typeof candidates === 'number' && candidates > 1 && (
        <p className="text-sm text-text-secondary">
          {localize('com_evidence_candidates', { total: candidates })}
        </p>
      )}

      <section>
        <p className="text-sm font-medium text-text-primary">
          {localize(integrityLabelKey(data.integrity?.recomputed))}
        </p>
        {present(contentHash) && (
          <Row label={localize('com_evidence_content_hash')} value={contentHash as string} />
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-primary">
          {localize('com_evidence_tool_calls')}
        </h3>
        {toolCalls.length === 0 ? (
          <p className="text-sm text-text-secondary">{localize('com_evidence_tool_calls_none')}</p>
        ) : (
          <ul className="list-disc pl-5 text-sm text-text-primary">
            {toolCalls.map((call, index) => (
              <li key={call.id ?? index}>
                {localize('com_evidence_tool_call_line', {
                  tool: call.tool_name ?? '',
                  scope: call.granted_scope ?? '',
                })}
                {present(call.error) && (
                  <span className="text-text-secondary">
                    {' '}
                    ({localize('com_evidence_tool_call_error', { error: call.error })})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {images.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-text-primary">
            {localize('com_evidence_images')}
          </h3>
          <ul className="list-disc pl-5 text-sm text-text-primary">
            {images.map((image, index) => (
              <li
                key={`${image.sha256 ?? 'image'}-${index}`}
                data-testid={`evidence-image-${index}`}
              >
                <span className="break-all">
                  {localize('com_evidence_image_line', {
                    type: image.media_type ?? image.kind ?? '',
                    size: localize('com_evidence_bytes', { size: image.bytes ?? 0 }),
                    sha256: image.sha256 ?? '',
                  })}
                </span>
                {image.status !== undefined && image.status !== 'recorded' && (
                  <span> ({localize('com_evidence_image_status', { status: image.status })})</span>
                )}{' '}
                <span className="text-text-secondary">
                  {localize('com_evidence_image_not_stored')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
