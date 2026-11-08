# LC-10a AC-P2 probe verdict (ADDENDUM-5 §5, C1)

Image: lfds/audittrace-librechat:768de61 (id sha256:4db01e94ee7b...), chart-rendered librechat.yaml
(librechat.rendered.yaml; run B adds the single X-Session-Id line). Real client driven by headless chromium
(instruments/drive.py). Local email login (the stack has no Keycloak); the Authorization value is never recorded.

P-2 (recorded at the LibreChat API INBOUND side, C1) -- records/run-a-rendered/p2.jsonl (and run-b-plus-header/p2.jsonl, identical shape)

- NEW chat, first upload (POST /api/files): fields [endpoint, endpointType, file, file_id, message_file]; conversationId ABSENT => RED
- EXISTING chat upload: fields [endpoint, endpointType, file, file_id, conversationId, message_file, agent_id]; conversationId PRESENT (= the chat's id) => GREEN
  => selects the iff-branch "composer sends the id on the first upload of a new chat" (R-Q3).

P-1 (recorded at the BFF-inbound recorder) -- records/run-b-plus-header/p1.jsonl

- POST /v1/chat/completions, both messages (first of a new chat, and of the existing chat): header x-session-id PRESENT, value = the conversation id
  (run A, without the added line: x-session-id ABSENT, records/run-a-rendered/p1.jsonl) => GREEN
  => the iff "custom-endpoint request path adds X-Session-Id" is NOT selected; the chart line is added instead (AuditTrace-AI side, separate WP).

FINDING (feeds the R-Q3 branch): for a new chat the conversation id does not exist client-side at upload time. The client sends
conversationId=null on first submit (useChatFunctions.ts:452-455) and the SERVER mints it as
uuidv5(`${userId}:${clientRequestId}`, NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE) (api/server/controllers/agents/request.js:723-728).
So "the composer sends the id on the first upload" needs a design (client-minted pending id honoured by the server) that the spec does not define.
