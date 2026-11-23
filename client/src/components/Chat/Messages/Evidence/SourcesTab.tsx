import { useLocalize } from '~/hooks';
import type { TEvidenceV1 } from '~/data-provider/Evidence';

/**
 * The "Sources" tab. `not_recorded` is shown verbatim with its meaning: an empty list that reads as
 * "checked, found nothing" is the one thing this tab must never show for a row that has no record.
 */
export default function SourcesTab({ data }: { data: TEvidenceV1 }) {
  const localize = useLocalize();
  const status = data.sources?.status;
  const items = Array.isArray(data.sources?.items) ? (data.sources?.items ?? []) : [];

  if (status !== 'recorded') {
    return (
      <div className="flex flex-col gap-1 text-sm text-text-primary">
        <p>
          {localize('com_evidence_sources_status', { status: String(status ?? 'not_recorded') })}
        </p>
        <p className="text-text-secondary">{localize('com_evidence_sources_not_recorded')}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return <p className="text-sm text-text-secondary">{localize('com_evidence_sources_none')}</p>;
  }

  return (
    <ul className="list-disc pl-5 text-sm text-text-primary">
      {items.map((item, index) => {
        const owned = item.visibility?.owner_is_caller;
        return (
          <li
            key={item.id ?? `${item.source_ref}-${index}`}
            data-testid={`evidence-source-${index}`}
          >
            <span className="break-all">
              {localize('com_evidence_source_line', {
                source: item.source_ref ?? '',
                tier: item.visibility?.tier ?? '',
              })}
            </span>
            {typeof owned === 'boolean' && (
              <span className="text-text-secondary">
                {' '}
                ({localize(owned ? 'com_evidence_source_owned' : 'com_evidence_source_not_owned')})
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
