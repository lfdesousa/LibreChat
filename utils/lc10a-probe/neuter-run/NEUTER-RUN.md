# LC-10a fork R-Q3: jest neuter run for AC-21 / AC-21b / AC-22 / AC-23 (c4)

Each row: one guard removed (mutation applied to the product file), the named jest target run, the file restored, the same target run again.
`neutered` is the jest `Tests:` line with the guard removed; `restored` is the same target after `git`-clean restore. RED = `neutered` has failures and `restored` has none.
Instrument: `neuter.py` (this directory): copies the file, replaces the first occurrence of OLD with NEW, runs `npx jest <args>` in the package, restores the file (in a `finally`), runs jest again, appends one JSON line to `neuter-results.jsonl`.
Runner: jest 30, jsdom for `client/`, node for `api/`. No wall-clock asserts; no skips.

| # | neuter (what was removed or changed) | neutered | restored | verdict |
|---|---|---|---|---|
| 1 | AC-21 namespace edited inside helper | 3 failed, 125 passed, 128 total | 128 passed, 128 total | RED->GREEN |
| 2 | AC-21 request.js inline uuidv5 changed namespace | 1 failed, 127 passed, 128 total | 128 passed, 128 total | RED->GREEN |
| 3 | AC-21 namespace literal pasted into crud.js | 1 failed, 4 passed, 5 total | 5 passed, 5 total | RED->GREEN |
| 4 | AC-21b GenerationJobManager copy quantifier edited | 1 failed, 4 passed, 5 total | 5 passed, 5 total | RED->GREEN |
| 5 | AC-21b request.js re-declares inline | 1 failed, 4 passed, 5 total | 5 passed, 5 total | RED->GREEN |
| 6 | AC-21 derivation order swapped | 2 failed, 126 passed, 128 total | 128 passed, 128 total | RED->GREEN |
| 7 | AC-22(e) drop E4 seed carry-forward | 2 failed, 14 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 8 | AC-22(e) drop E4 digest carry-forward | 2 failed, 14 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 9 | AC-22(e) drop E5 empty-check seed clause (seeded record deleted) | 3 failed, 13 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 10 | AC-22(g) drop persist owner gate (S1.3: write B seed over owner's record) | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 11 | AC-22(g)/S1 drop owner gate on clearNewChatSeed record half | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 12 | AC-22(c) read the seed without the owner gate | 2 failed, 14 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 13 | AC-22(h1) skip the comparison (always reuse) | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 14 | AC-22(h2) always mint on resend | 3 failed, 13 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 15 | AC-22(h)/S5 change the canonical form | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 16 | AC-22(h)/S5 change the algorithm tag | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 17 | N1 no seed held: mint+store instead of bare v4 | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 18 | S2 claimComposerDraftTab drops the carry | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 19 | S2 claimComposerDraftTab adopts a live foreign seed | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 20 | S2 releaseComposerDraftTab drops the carry (deletes seeded record) | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 21 | AC-22(f) observer never clears on server-id adoption | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 22 | AC-22(f) observer clears on the return to NEW_CONVO (failed-submit cancel) | 2 failed, 14 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 23 | AC-22(f)/N4 flag not kept in the module (reset per call) | 1 failed, 15 passed, 16 total | 16 passed, 16 total | RED->GREEN |
| 24 | AC-22(a)/(b) clear the seed at hand-off (ask) | 5 failed, 1 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 25 | AC-22(a) ask ignores the seed (v4 always) | 4 failed, 2 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 26 | AC-22(d) override no longer wins over the seed | 1 failed, 5 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 27 | AC-22(a) upload omits clientRequestId | 3 failed, 3 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 28 | AC-22(i) drop the isConversationUpload gate on the seed | 1 failed, 5 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 29 | AC-22 existing chat also gets a seed | 1 failed, 5 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 30 | S3 default the index to 0 | 2 failed, 4 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 31 | S3 chat-context variant drops the index | 1 failed, 5 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 32 | S3 AttachFile drops the index | 1 failed, 29 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 33 | S3 FileFormChat drops the index | 1 failed, 29 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 34 | S3 AttachFileMenu drops the index (upload hook) | 1 failed, 29 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 35 | S3 AttachFileMenu drops the index (SharePoint hook) | 1 failed, 29 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 36 | AC-22(f) C1 gated by saveDrafts | 1 failed, 30 passed, 31 total | 31 passed, 31 total | RED->GREEN |
| 37 | AC-22(f) C1 effect removed | 2 failed, 29 passed, 31 total | 31 passed, 31 total | RED->GREEN |
| 38 | C2 discard block no longer clears the seed | 1 failed, 4 passed, 5 total | 5 passed, 5 total | RED->GREEN |
| 39 | C2/AC-22(b) seed cleared at the token renewal (failed-submit cancel) | 3 failed, 2 passed, 5 total | 5 passed, 5 total | RED->GREEN |
| 40 | C3 New Chat button no longer clears the seed | 1 failed, 43 passed, 44 total | 44 passed, 44 total | RED->GREEN |
| 41 | AC-22(h) warn log gains a field beyond the lengths (ask-level exact-shape assert) | 1 failed, 5 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 42 | N1 ask-level: resolveNewChatSeed mints+stores when no seed is held | 1 failed, 5 passed, 6 total | 6 passed, 6 total | RED->GREEN |
| 43 | AC-23 widen the shape to {1,256} | 2 failed, 34 passed, 36 total | 36 passed, 36 total | RED->GREEN |
| 44 | AC-23 drop the {{ }} markers | 3 failed, 33 passed, 36 total | 36 passed, 36 total | RED->GREEN |
| 45 | AC-23 trim() instead of space-only strip (trailing LF slips through) | 2 failed, 34 passed, 36 total | 36 passed, 36 total | RED->GREEN |
| 46 | AC-23 no strip at all | 2 failed, 34 passed, 36 total | 36 passed, 36 total | RED->GREEN |
| 47 | AC-23 warn leaks the value | 11 failed, 25 passed, 36 total | 36 passed, 36 total | RED->GREEN |
| 48 | AC-23 throw instead of dropping the header (ERR_INVALID_CHAR shape) | 12 failed, 24 passed, 36 total | 36 passed, 36 total | RED->GREEN |
| 49 | AC-21 upload derives with (seed,user) swapped | 2 failed, 19 passed, 21 total | 21 passed, 21 total | RED->GREEN |
| 50 | AC-21 upload derives for a fixed user (not namespaced) | 3 failed, 18 passed, 21 total | 21 passed, 21 total | RED->GREEN |
| 51 | A' precedence: seed beats conversationId | 2 failed, 19 passed, 21 total | 21 passed, 21 total | RED->GREEN |
| 52 | A' drop the seed shape test | 2 failed, 19 passed, 21 total | 21 passed, 21 total | RED->GREEN |
| 53 | A' derive without an authenticated user | 1 failed, 20 passed, 21 total | 21 passed, 21 total | RED->GREEN |
| 54 | AC-23 drop the shape test | 9 failed, 27 passed, 36 total | 36 passed, 36 total | RED->GREEN |

**54 of 54 neuters went RED and returned GREEN on restore.** Rows with a verdict other than RED->GREEN: 0.

## Neuters attempted and withdrawn, with the reason (not counted above)
- E6 bare-array clause (`&& !seed`): the neuter stayed GREEN. `tabId` is `(claimed live ? claimed : getBrowserTabId()) || undefined` and `getBrowserTabId` never returns `''` (`mintTabId` falls back to a local id), so the bare-array branch is unreachable for any record in a browser. The clause was removed from `setFilesDraft` rather than kept as an unprovable guard, and the corresponding test deleted (spec deviation, see the build record).
- A first "derivation order swapped" neuter replaced the docblock occurrence instead of the code line and stayed GREEN; it was redone with the `return uuidv5(` prefix and went RED (row above).
- A first "warn log carries the submitted text" neuter was placed in `useChatFunctions.ts`, where the extra field is dropped by `resolveNewChatSeed`; it stayed GREEN and was replaced by the exact-shape neuter in `newChatSeed.ts` (row above).
- A first N1 ask-level neuter had a syntax error (`0 total`), which is RED for the wrong reason; replaced by the `resolveNewChatSeed` mutation (row above).

## Parity: client shape check vs the memory server's `header_session_id`
`parity/server_side.py` executes the VERBATIM source of `header_session_id` from AuditTrace-AI `6a42c499` (`_session_bind.py`, sha256 prefix 1ae0f1659aa47163; the source file is NOT shipped in this public fork: it is kept in the private evidence folder (private evidence, not published), and `server_side.py` takes its path as argv[1]) over `parity/cases.json` (27 values); `parity/client_side.js` runs the same values through `callConsoleFilesProxy` (axios stubbed) and records the `X-Session-Id` it would send.
Result: **27 of 27 cases equal (0 differences)**, including 256 characters, U+0000, a trailing and a leading line feed, CR/LF, tab, U+00FF, inner space, `{{`, `}}`, `{ {`, `}{`, and the 255-character boundary. Outputs: `parity/server.json`, `parity/client.json`.

## Round r2 (review r1 B-1, B-2): added tests and their neuters

| # | neuter | neutered | restored | verdict |
|---|---|---|---|---|
| 1 | B-1 ChatForm.tsx AttachFileChat index={index} -> index={0} | 1 failed, 29 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 2 | B-1 AttachFileChat.tsx AttachFile index={index} -> index={0} | 1 failed, 29 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 3 | B-1 AttachFileChat.tsx AttachFileMenu index={index} -> index={0} | 2 failed, 28 passed, 30 total | 30 passed, 30 total | RED->GREEN |
| 4 | B-2 digest ignores the file set: submissionDigest(text, []) | 2 failed, 6 passed, 8 total | 8 passed, 8 total | RED->GREEN |
| 5 | B-2 digest ignores overrideFiles (composer map only) | 1 failed, 7 passed, 8 total | 8 passed, 8 total | RED->GREEN |

Tests added: `AttachFileChat.spec.tsx` (index reaches AttachFileMenu and AttachFile), `ChatForm.attachments.spec.tsx` (a pane-1 composer uploads under pane 1's seed, through the real ChatForm -> AttachFileChat -> AttachFileMenu -> upload hook chain), `useChatFunctions.newChatSeed.spec.tsx` (same text + changed composer files -> fresh seed; digest follows overrideFiles).
