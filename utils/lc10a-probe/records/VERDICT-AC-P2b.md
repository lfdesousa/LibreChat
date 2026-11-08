# LC-10a AC-P2b: the probe re-run on the A' image

Image: lfds/audittrace-librechat:a886a77 (id sha256:6bb013783cfb...), built locally from the fork branch at a886a77
(`docker build -t lfds/audittrace-librechat:a886a77 -f Dockerfile .`; product code identical to ab03bc8, a886a77 only adds the c4 neuter-run files).
Stack: `stack.sh up plus-header` (explicit container names `lc10a-probe-*`, removed with `docker rm -fv`, network removed), the chart-rendered
`librechat.rendered.yaml` plus the single `X-Session-Id: '{{LIBRECHAT_BODY_CONVERSATIONID}}'` line (the P-1 variant), throwaway secrets,
real client driven by headless chromium (`drive.py`, unchanged since 8e9da8b). Instruments: `recorder.py` (adds the value of the
`clientRequestId` field: a client-minted UUID, not a secret), `p2b_verify.py` (new). Authorization/Cookie values are never read.

Records: `records/run-aprime-plus-header/{p1,p2}.jsonl`; verifier output: `p2b-verify.out` (all_pass true).

- Check 1 (P-2 inbound, the API side): the NEW chat's first upload (`POST /api/files`) carries `clientRequestId` and NO `conversationId`
  (fields: endpoint, endpointType, file, file_id, clientRequestId, message_file). At 768de61 (VERDICT.md) it carried neither.
- Check 2 (the equality AC-P2b names): uuid5("<user _id>:<seed>", d7f2518c-94b8-4fe8-97ad-2d4bdb2c9f43) == the `x-session-id` the BFF recorder
  saw on the new chat's `/v1/chat/completions` == `deriveNewConversationId(userId, seed)` executed INSIDE the image
  (`docker exec ... node`). All three: d093ea70-8c62-5bd6-9bba-15ab54765bdd. The user \_id is read from the probe's own throwaway Mongo.
- Check 3: the EXISTING chat's upload carries `conversationId` == that same value.

NOT shown by this probe (named, not hidden): the upload's own `X-Session-Id` header at the BFF. The probe stack logs in with a local email
account, so `req.session.openidTokens.accessToken` is absent and `uploadVectorsSovereign` does not reach the BFF (it would throw
MissingAccessTokenError). The upload-side derivation is proven at the unit layer (crud.sovereign.spec.js, AC-21: the value the upload passes
equals the id request.js mints for the same user and seed, known-answer 2240435c-9302-5c0a-900c-28ee7f7cbe8c) and by check 2 above
(the image's own helper). The end-to-end leg through Keycloak, the BFF and the memory server belongs to AC-12 in the rollout.
