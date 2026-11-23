import {
  Tabs,
  TabsList,
  OGDialog,
  TabsTrigger,
  TabsContent,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import { useEvidenceQuery } from '~/data-provider/Evidence';
import { useLocalize } from '~/hooks';
import { errorMessageKey } from './evidenceModel';
import ReconstructTab from './ReconstructTab';
import VisibilityTab from './VisibilityTab';
import SourcesTab from './SourcesTab';

type EvidenceDialogProps = {
  open: boolean;
  messageId: string;
  onOpenChange: (open: boolean) => void;
};

/**
 * "Reconstruct this answer": a read-only view of what the audit trail recorded for one assistant
 * message. It renders the BFF response the fork API relays and stores nothing (no Mongo, no local
 * storage; react-query memory only). The lookup is by the message's own id, only while open.
 */
export default function EvidenceDialog({ open, messageId, onOpenChange }: EvidenceDialogProps) {
  const localize = useLocalize();
  const { data, isLoading, isError, error } = useEvidenceQuery(messageId, open);

  let body: React.ReactNode;
  if (isError) {
    body = <p className="text-sm text-text-primary">{localize(errorMessageKey(error))}</p>;
  } else if (isLoading || data === undefined) {
    body = <p className="text-sm text-text-secondary">{localize('com_evidence_loading')}</p>;
  } else {
    body = (
      <Tabs defaultValue="reconstruct" className="w-full">
        <TabsList className="mb-3 flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="reconstruct">{localize('com_evidence_tab_reconstruct')}</TabsTrigger>
          <TabsTrigger value="sources">{localize('com_evidence_tab_sources')}</TabsTrigger>
          <TabsTrigger value="visibility">{localize('com_evidence_tab_visibility')}</TabsTrigger>
        </TabsList>
        <TabsContent value="reconstruct">
          <ReconstructTab data={data} />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesTab data={data} />
        </TabsContent>
        <TabsContent value="visibility">
          <VisibilityTab data={data} />
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="max-h-[85vh] w-11/12 max-w-2xl overflow-y-auto rounded-2xl">
        <OGDialogTitle className="text-base font-semibold leading-6 text-text-primary">
          {localize('com_evidence_title')}
        </OGDialogTitle>
        <OGDialogDescription className="text-sm text-text-secondary">
          {localize('com_evidence_description')}
        </OGDialogDescription>
        {body}
      </OGDialogContent>
    </OGDialog>
  );
}
