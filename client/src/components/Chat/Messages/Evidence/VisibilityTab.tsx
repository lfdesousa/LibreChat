import { useLocalize } from '~/hooks';
import type { TEvidenceV1 } from '~/data-provider/Evidence';
import { serviceReaderLines } from './evidenceModel';

/**
 * The "Who can see this" tab. It reports the mechanism the payload names and speaks about THIS
 * AUDIT RECORD only: LibreChat's own copy of the conversation and its shared links are separate
 * stores with their own rules, and the tab says so rather than implying they are covered.
 */
export default function VisibilityTab({ data }: { data: TEvidenceV1 }) {
  const localize = useLocalize();
  const answer = data.visibility?.answer;
  const readers = Array.isArray(answer?.api_readers) ? (answer?.api_readers ?? []) : [];
  const serviceLines = serviceReaderLines(answer?.service_readers);
  const operator = answer?.operator_access;

  const readerLabel = (reader: string) => {
    if (reader !== 'owner') {
      return reader;
    }
    return localize(
      answer?.owner_is_caller ? 'com_evidence_reader_owner_you' : 'com_evidence_reader_owner_other',
    );
  };

  return (
    <div className="flex flex-col gap-2 text-sm text-text-primary">
      <p className="text-text-secondary" data-testid="evidence-visibility-scope">
        {localize('com_evidence_visibility_scope')}
      </p>
      {readers.length > 0 && (
        <p>
          {localize('com_evidence_visibility_api', {
            readers: readers.map(readerLabel).join(', '),
          })}
        </p>
      )}
      {serviceLines.map((line, index) =>
        line.kind === 'unverified' ? (
          <p key={`unverified-${index}`}>
            {localize('com_evidence_visibility_service_unverified')}
          </p>
        ) : (
          <p key={`${line.role}-${index}`}>
            {typeof operator === 'string' && operator !== ''
              ? localize('com_evidence_visibility_service', {
                  role: line.role,
                  purpose: line.purpose,
                  operator,
                })
              : localize('com_evidence_visibility_service_only', {
                  role: line.role,
                  purpose: line.purpose,
                })}
          </p>
        ),
      )}
      {serviceLines.length === 0 && typeof operator === 'string' && operator !== '' && (
        <p>{localize('com_evidence_visibility_operator', { operator })}</p>
      )}
    </div>
  );
}
