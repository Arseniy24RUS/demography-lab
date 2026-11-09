# Stage 3 RPC contract

All RPCs use named parameters and authenticated Supabase users. Every mutation also requires `p_operation_id uuid`; replaying the same operation/payload returns the current snapshot without applying the mutation again. Current membership is checked before replay. Stable error codes are translated by the application.

| Function | Parameters after session | Result |
| --- | --- | --- |
| `dw_workshop_snapshot` | `p_session_id uuid` | `WorkshopSnapshot` |
| `dw_workshop_cursor` | `p_session_id uuid` | Nonnegative safe integer |
| `dw_workshop_projector_snapshot` | `p_session_id uuid` | `WorkshopProjection`, host only |
| `dw_workshop_round_snapshot` | `p_session_id uuid, p_round_id uuid` | `VotingRound` |
| `dw_region_work` | `p_session_id uuid, p_region_id text, p_action text, p_expected_revision bigint, p_note text, p_operation_id uuid` | `WorkshopSnapshot` |
| `dw_save_family` | `p_session_id uuid, p_family_id uuid nullable, p_expected_board_revision bigint, p_title text, p_mechanism text, p_rationale text, p_submission_ids uuid[], p_operation_id uuid` | `WorkshopSnapshot` |
| `dw_delete_family` | `p_session_id uuid, p_family_id uuid, p_expected_board_revision bigint, p_operation_id uuid` | `WorkshopSnapshot` |
| `dw_open_voting_round` | `p_session_id uuid, p_title text, p_results_visibility text, p_expected_board_revision bigint, p_operation_id uuid, p_settings jsonb default '{}'` | `WorkshopSnapshot` |
| `dw_close_voting_round` | `p_session_id uuid, p_round_id uuid, p_expected_revision bigint, p_operation_id uuid` | `WorkshopSnapshot` |
| `dw_cast_vote` | `p_session_id uuid, p_round_id uuid, p_family_id uuid, p_value integer, p_expected_revision bigint, p_operation_id uuid` | `WorkshopSnapshot` |
| `dw_workshop_updates` | `p_session_id uuid, p_known_round_id uuid default null` | Compact `WorkshopSnapshot` |
| `dw_workshop_projector_updates` | `p_session_id uuid, p_known_round_id uuid default null` | Compact `WorkshopProjection`, host only |
| `dw_cast_vote_updates` | Same parameters as `dw_cast_vote`, plus `p_known_round_id uuid default null` | Compact `WorkshopSnapshot` |

Compact endpoints set each `round.families[].variants` to null only when the latest round ID equals `p_known_round_id`. The client must send a known ID only after caching all validated immutable material for that session and round. On absent/stale known IDs the complete materials are returned. Restore the cached variants before strict parsing; a missing/incomplete cache requires a full fetch with null, never an empty-array substitute. Every dynamic field is fresh, including myVote/revision, totals, permissions and cursor. The projector compact endpoint still requires host authorization and never returns other participants' individual ballots. This reduces network bytes; database JSON construction remains bounded by the snapshot limits.

New Realtime table: `public.dw_workshop_events`, filter `session_id=eq.<id>`, INSERT only. Notification fields are `id, session_id, cursor, event_type, created_at`; no ballots, authors or text. `dw_workshop_cursor` also advances on relevant Stage 2 session/member/submission changes, without advancing the Stage 2 cursor for workshop-only operations.

Region actions are available in an open session during reading/review. Only a sealed corpus region can be allocated. Claim uses revision 0 for an untouched region; competing stale claims fail. Claim/reopen/renew issues a 30-minute lease. Renew is an explicit action by the owner or host. An expired in-progress allocation may be claimed using its current revision; a previous owner cannot renew or complete an expired/reassigned allocation. Owner or host may release, complete or reopen. Completing without a shared source-backed submission from that region requires an explanatory note of at least 10 non-padding characters. `leaseExpiresAt` is null for available/completed records.

Only the host curates families, in open reading/review phases. The full member set of the target family is replaced. Submissions moved from other families retain their original bundles and citations; emptied families remain available for explicit editing/deletion. One submission belongs to at most one family. All curation uses the global board revision. An open round prevents curation and changes to participating submission content/status.

The host opens a round in an open discussion phase. Every non-empty family is captured with metadata, canonical bundles, submission revisions and the eligible host/participant roster. Empty families are excluded. At most one round is open. Each eligible member may currently hold one value (-1, 0, +1) for each captured family. Zero is an explicit abstention and counts as an answer. A null `p_value` withdraws the answer; an absent/withdrawn ballot is not counted in cast. Current participant/host role and active membership remain required; late joiners wait for the next round. Previously cast ballots are retained if a voter is later revoked or becomes an observer; the eligible denominator is the immutable opening roster. Closed rounds never inherit later edits or later ballots. A new round starts from zero ballots.

`resultsVisibility=after_close` is required for the first round and hides totals from every role and from the projector until closure; only participation counts are visible. An explicit teacher selection of `live` on a later round exposes aggregates as they change. Neither mode returns the individual ballots of other members. Totals distinguish support, oppose, neutral, cast (all explicit answers), unanswered (eligible minus cast) and score (support minus oppose). `substantive=A+D`, `coverage=(A+D+Z)/R`, `supportRatio=A/(A+D)`, `net=(A-D)/(A+D)`; zero denominators yield null. `qualifies` requires coverage and substantive thresholds captured before opening. Projector data omits profile IDs, participant names, membership lists and own-ballot fields. Free text in submitted bundles is authored material, not automatically anonymized.

Round settings allow `promptText` (default: «Считаете ли Вы эту практику приоритетной для адаптации в выбранном контексте?»), `minCoverage` (default .7) and `minSubstantiveVotes` (default min(3,eligibleCount)). `contextScope` and `contextRegionId` are captured from the session; `evaluationDimension` is `priority_for_adaptation`. All eligible members are assigned all captured families in Stage 3. Each roster entry has a persisted random ordering seed; personal snapshots return families in that stable order. Balanced packet assignment is deferred.

Additional error codes: `REGION_UNAVAILABLE`, `REGION_TAKEN`, `LEASE_EXPIRED`, `COMPLETION_NOTE_REQUIRED`, `ROUND_OPEN`, `ROUND_CLOSED`, `ROUND_NOT_READY`, `NOT_ELIGIBLE`, `FIRST_ROUND_BLIND`. Existing Stage 2 codes (`FORBIDDEN`, `REVISION_CONFLICT`, `SESSION_NOT_OPEN`, `PHASE_CLOSED`, `INVALID_INPUT`, `LIMIT_EXCEEDED`, `IDEMPOTENCY_CONFLICT`) keep their meaning.
