# Stage 4 RPC contract

This is the implementation contract. Named mutations take `p_operation_id uuid`, `p_session_id uuid`, and a complete `p_input jsonb` matching the exported input type. They return the current `BarriersSnapshot` after committing or replaying a command. The server derives identity, checks current membership and serializes the session before checking revisions. The anonymous form uses a separate origin and transport with no account bearer or SDK Auth storage.

| RPC | Arguments | Result |
| --- | --- | --- |
| `dw_barriers_snapshot` | `p_session_id` | `BarriersSnapshot` |
| `dw_barriers_cursor` | `p_session_id` | safe integer |
| `dw_barriers_projector_snapshot` | `p_session_id` | `BarriersProjection`, host only |
| `dw_save_barrier` | named mutation tuple, `SaveBarrierInput` | `BarriersSnapshot` |
| `dw_barrier_vote` | named mutation tuple, `BarrierVoteInput` | `BarriersSnapshot` |
| `dw_save_barrier_link` | named mutation tuple, `SaveBarrierLinkInput` | `BarriersSnapshot` |
| `dw_save_solution` | named mutation tuple, `SaveSolutionInput` | `BarriersSnapshot` |
| `dw_barrier_evidence` | `p_session_id,p_evidence_id` | `BarrierEvidence` |
| `dw_save_survey` | named mutation tuple, `SurveyConfigInput` | `BarriersSnapshot` |
| `dw_manage_survey` | named mutation tuple, `SurveyActionInput` | `BarriersSnapshot` |
| `dw_survey_host_state` | `p_session_id,p_survey_id` | `SurveyHostState`, host only |
| `dw_survey_invitation_state` | `p_session_id,p_survey_id` | `SurveyInvitationState`, host only; digest metadata, no responses |
| `dw_survey_research_export` | `p_session_id,p_survey_id` | `SurveyResearchExport`, host only |
| `dw_survey_public_manifest` | `p_survey_id,p_invitation_token` | `SurveyPublicManifest`, anon only |
| `dw_survey_own_response` | `p_survey_id,p_response_secret` | `SurveyOwnResponse`, anon only |
| `dw_survey_save_response` | `p_operation_id,p_survey_id,p_invitation_token,p_response_secret,p_input` | `SurveyOwnResponse`, anon only |
| `dw_survey_withdraw_response` | `p_operation_id,p_survey_id,p_response_secret,p_expected_revision` | `SurveyOwnResponse`, anon only |

Public survey functions reject a non-null `auth.uid()` and an authenticated JWT role. Tokens are lowercase 64-character hex. Response secrets are generated independently of the invitation and named account; only domain-separated hashes are stored. The response tables and receipt tables have no profile foreign key or timestamp finer than UTC date. Public transport must omit account credentials. No raw response, response UUID, consent fields, invitation token or withdrawal secret appears in the board, its events or the projector.

The host generates the invitation token on creation and stores it locally. Server snapshots never recover it. Explicit `rotate` replaces its hash; an existing respondent can still retrieve/withdraw their own answer using `surveyId + responseSecret`. Withdrawal clears all text and answer fields, retains a tombstone, and prevents an old save replay from restoring the response. Closed surveys still accept withdrawal. Expired surveys reject raw reads and exports; purge remains available. A raw response token is a bearer capability and must not enter a URL, referrer, telemetry or a public export.

Stage IDs are `life_plans`, `first_child`, `preparation_pregnancy`, `infancy`, `early_childhood`, `preschool`, `school`, `next_child`. A barrier has one primary stage and a unique nonempty set of up to eight stages containing it. Its `contentRevision` changes with content/context; prioritization alone does not invalidate evidence links. Authors/hosts edit their cards, links and solutions; only a host changes priority. Observers read. Open-session writes work in every teaching phase, so brainstorming may precede document reading. Discussion votes +1, −1, 0 and null remain distinct and are shown as counts, without fixed-denominator percentages or a claim of blinded comparison.

Link input captures the current barrier revision and family fingerprint. The server freezes the complete source family edition and original regional bundles once per fingerprint. Every link references this immutable evidence ID. Board updates carry only metadata; `dw_barrier_evidence` retrieves source material on demand. Revisions and publication withdrawal change the current family fingerprint; changed/missing targets and changed/archived barriers yield explicit `staleReasons`. Stale and archived links are excluded from coverage by the client. Prior evidence remains retrievable after a family changes or disappears. Archive uses status updates; no public hard deletion rewrites prior evidence.

One non-purged survey is allowed per teaching session. A draft can be edited; opening freezes question wording/version, purpose and retention. Close is final. A later survey requires purging the preceding survey first. Counts smaller than five are suppressed on collective views. The private host state is the only source of exact counts and raw responses; export filters to current research consent, includes quotation permission, questionnaire/procedure versions, missing codes and a sampling note. The open-link mechanism does not establish one-person uniqueness or population representativeness.

Every questionnaire field is explicit in save input, with null for skipped/not-asked questions. `consentQuote` requires `consentResearch`; educational consent and adult confirmation are mandatory for submission. A declined perspective cannot carry substantive answers. Baseline intentions and conditional change are accepted only in the self branch. Conditional change requires a nonempty priority condition with a UUID. Changing its text requires a new condition UUID; the frontend clears the old conditional assessment. Missing IDs/fields are rejected rather than inheriting previous values.

For a substantive perspective, at least one of `answerBarrier` and `answerSupport` must be nonempty. Either individual question may be skipped; a completely empty substantive answer is rejected. The explicit `decline` perspective remains available with all substantive fields null and educational/adult consent. Invitation recovery uses `dw_survey_invitation_state`, never an automatic raw host-state request.

New Realtime table: `public.dw_barrier_events`, INSERT notifications with `id,session_id,cursor,event_type,created_at`. It contains no author IDs or content. A scalar cursor advances on named card/link/solution changes, relevant source/family/member/session updates and host survey configuration/state changes. Anonymous responses do not produce events, actor ledgers or exact-time activity records; safe counts are refreshed explicitly or by a coarse (approximately 30-second) polling request while a survey is open. It does not advance for Stage 3 ballot changes. Full SQL and schema validation remain the authoritative bounds; deployment needs a separate survey origin, explicit allowed CORS origins, hosted service tests and an appropriate retention/purge procedure.

`expectedBarrierRevision` refers to the full `barrier.revision`; existing links store `contentRevision`, so priority-only edits do not stale prior links. Archiving an existing link checks its own revision and unchanged target IDs while preserving evidence, even when a family has disappeared. The host-only state exposes `invitationDigest = SHA256(UTF8("dw-survey-invite:" + token))`, never the token. Own-response receipts expose `availability = open|closed|expired|purged`; expired and purged reads return blank answers. The projector survey object contains only title, status and the suppressed response count.

Bounds: 200 barriers, 600 links, 200 solutions and 250 survey receipt slots per session/survey; withdrawal leaves a slot tombstone. Barrier/solution titles are 5–240 characters. Barrier description and free survey answers are at most 4000; link explanation 10–4000 and prerequisites 0–4000. Solution targetGroup is 3–1000, mechanism 10–4000, firstStep/responsible/resources/successIndicator 3–2000, risks 0–2000. Survey title is 5–240, purpose 20–4000, organizerContact 5–1000, editable question wording 10–1000. Evidence is at most 8 MiB per shared immutable family edition, 64 MiB per teaching session. A response replaces every questionnaire field explicitly; no prior value is inherited.

## Shared workshop entry (0.9)

`dw_workshop_survey(p_session_id)` returns `WorkshopSurveyEntry {sessionId, survey, invitationToken}` for an existing participant or host of the installation's current workspace. A session row lock serializes get-or-create. The first participant can initialize the same default open survey as a later teacher. Newly initialized surveys retain answers for 365 days, with the precise date disclosed before consent. Initialization records no response, respondent identity or consent. Closed/expired surveys are not reopened and retention is not extended by reading metadata. The entry screen reports closed/expired collection and the retention date without blocking the rest of the workshop.

For this shared workflow only, the common form token is recoverable from `private.dw_workshop_survey_access` after current-workspace and membership checks. It is a launch capability, not a respondent secret. It opens the anonymous form and cannot read another respondent's answer. The table has RLS and no direct public/anon/authenticated grants; the public wrapper is `SECURITY INVOKER` and the private implementation verifies the actor/member. Historical manually managed survey links retain their original contract. Rotating a shared launch token never changes personal response secrets or answers.

`ConnectedSurveyStart` is the first shared page for every participant. It requests launch metadata only; it never imports the public form into an account context or reads private answers. The response-count refresh is coarse (30 seconds). The anonymous form opens on its configured separate origin via a no-referrer link. Host response review is explicit in a collapsed analysis section. A personal receipt is optional readable text, with its secret outside the restore URL; no participant JSON export is required.
