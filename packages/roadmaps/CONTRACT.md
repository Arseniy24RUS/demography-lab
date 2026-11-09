# Stage 5: territorial roadmaps

One roadmap is unique per `(session_id, territory_key)`. Canonical territory identity comes from a sealed dataset imported by the administrator, never from client-provided labels. Municipality, region and federal room levels are selected by the host; the default matches the teaching session scope. The choice is locked after the first room exists. The first join binds the session to `dataEditionId`, and later joins require the same edition. Administrative districts in the source geometry are not silently treated as municipalities.

All reads require current verified session membership. Participants may read the session's roadmaps but write only their current room; the host may write every room. Observers cannot join or write. One active room assignment per user/session is revisioned. Moving teams preserves the former team's work. Writes require an open session in any teaching phase. User identity and current authorization are checked before operation replay.

## RPC surface

Named mutations receive `p_operation_id uuid, p_session_id uuid, p_input jsonb`. Inputs are complete and strict. Unknown fields, forged source records and cross-room references are rejected.

| RPC                            | Input beyond session      | Result                                            |
| ------------------------------ | ------------------------- | ------------------------------------------------- |
| dw_roadmaps_index              | none                      | RoadmapsIndex                                     |
| dw_roadmaps_cursor             | none                      | nonnegative safe integer                          |
| dw_roadmap_snapshot            | p_roadmap_id              | RoadmapSnapshot                                   |
| dw_configure_roadmaps          | ConfigureRoadmapsInput    | RoadmapsIndex                                     |
| dw_join_roadmap                | JoinRoadmapInput          | RoadmapSnapshot; client refreshes the small index |
| dw_save_roadmap_item           | SaveRoadmapItemInput      | RoadmapSnapshot                                   |
| dw_capture_roadmap_basis       | CaptureRoadmapBasisInput  | RoadmapSnapshot                                   |
| dw_capture_roadmap_fact        | CaptureRoadmapFactInput   | RoadmapSnapshot                                   |
| dw_freeze_roadmap              | FreezeRoadmapInput        | RoadmapSnapshot with the new version summary      |
| dw_roadmap_version             | p_roadmap_id,p_version_id | RoadmapVersion                                    |
| dw_review_roadmap              | ReviewRoadmapInput        | RoadmapSnapshot                                   |
| dw_roadmaps_projector_snapshot | p_roadmap_id nullable     | RoadmapsProjection, host only                     |

`dw_save_roadmap_item` is a discriminated union for passport, diagnosis, monitoring, activity, indicator, scenario, cost, funding, risk and fact. The three singleton sections exist when a room is created. Each item has its own revision. Edits of separate rows do not conflict through a shared expected revision. Editing the same row with stale data fails atomically; a client keeps the unsaved draft. The room revision advances for room mutations and is used when capturing a version.

Dates are calendar strings YYYY-MM-DD, not UTC instants. A date pair is either fully absent or two valid dates in increasing order. Cross-room references and dependency cycles are structural errors. Out-of-project dates and unmet finish-to-start schedules remain explicit readiness warnings; changing the project period does not silently move activities or annual budgets. Active references prevent archiving a needed activity, indicator, scenario or cost row.

## Sources and calculations

Imported statistics are canonical source-qualified series, loaded through the same deterministic adapter as the browser. Their IDs pin the dataset edition; SHA-256 fingerprints pin the material. Source-reported actuals retain incomplete primary provenance and unverified geographic comparability. Stage 6 adds separate immutable participant-supplied series; it never changes a sealed imported series. Neither stock sums nor approximate TFR reconstructions are imported as municipal demographic facts. Scenarios store only parameters and a reference to one immutable imported or participant-supplied series. The server rejects inappropriate/missing historical windows and incompatible target modes. The deterministic analytics package recalculates the results from the captured inputs and declared algorithm version.

Registry facts and `team_statistics` facts are captured by series ID, fingerprint and year; their number, unit and source are supplied by SQL. For team series the source belongs to that observation's override, or to the original series when the year was not edited. External facts remain `external_unverified`. Ordinary save cannot alter a captured statistical value. Editing its interpretation or archiving it preserves the captured source; an explicit recapture is required to change source/year. Stage 4 basis capture likewise reads the source on the server and preserves barrier/link/solution material and immutable family evidence. Changed/archived sources produce stale reasons. Research survey rows and identities are never valid source objects here.

## Stage 6: participant statistical actualization

`packages/statistics/types.ts` and `schema.ts` define four additional RPCs. Save and restore use the existing mutation signature with operation ID and session ID. History and material reads take `p_session_id,p_input`. Existing verified membership, open-session, own-room/host checks run before receipt replay. The imported dataset, historical version rows and previous four migrations are unchanged.

| RPC                             | Input                       | Result                                                 |
| ------------------------------- | --------------------------- | ------------------------------------------------------ |
| `dw_roadmap_statistics_save`    | `SaveStatisticsInput`       | `RoadmapSnapshot`                                      |
| `dw_roadmap_statistics_restore` | `RestoreStatisticsInput`    | `RoadmapSnapshot`                                      |
| `dw_roadmap_statistics_history` | `GetStatisticsHistoryInput` | `StatisticsHistory`, at most 50 entries                |
| `dw_roadmap_statistics_series`  | `GetStatisticsSeriesInput`  | `StatisticsSeriesPayload`, one immutable team revision |

Only the seven defined actual metrics are editable: births, deaths, annual average population, arrivals, departures, net migration and natural change. Their units, meaning, stock/flow semantics, signs and temporal references are fixed server-side. Manual entry is also possible when the territory has no imported row, including regional and federal rooms. This does not aggregate municipal values or certify current territorial comparability.

Save is a patch of unique year operations. `{year,action:'set',value:null}` records an explicitly unknown observation; zero is an observed zero. A set equal to an original value still records a new explicit source attribution. `{year,action:'reset'}` removes that year's override and restores its original value, or removes the year when the original lacked it. Source reference, optional source date and reason attach only to set observations in that command. All other years retain their previous provenance. Full restore creates an audit revision and sets the current head back to the original source, or to genuine absence if no original exists. It never deletes immutable team materials.

The sparse `statistics` array holds heads only for metrics that have been acted on. An absent head means revision zero and the original source. Each head contains metric, revision, mode, current series ID and time; no author identity. A team head must resolve to exactly the material's metric and revision. The snapshot includes current team series, original series for acted-on metrics and all older immutable series still referenced by a fact or scenario. History pages contain recorded authorship separately. Restore history entries may name the original canonical series; the team-material RPC is only for save entries.

Each team material contains full original `baseSeries` or null, all effective points, per-year overrides, comparison qualifications and its command metadata. It has `sourceKind:'team_reported'`, `provenanceStatus:'participant_supplied'`, a distinct immutable ID and an exact `canonicalJson`. SHA-256 covers the UTF-8 bytes of that JSONB text, excluding the `canonicalJson` and `fingerprint` fields themselves. Parsers check the closed shape and reproduction of points from original plus overrides; the transport/export verifies the byte hash. Participant-supplied material never receives a fabricated GitHub commit, file hash or source URL.

The expected revision is per room and metric. A conflicting save fails atomically with `REVISION_CONFLICT`; old facts/scenarios keep their stored material ID and fingerprint. Resetting the working series does not rewrite those references. The UI must explicitly recapture a fact or update a scenario to adopt a different source. New frozen snapshots use schemaVersion 2 and include heads. Old schemaVersion 1 snapshots parse without inserting a statistics default, preserving their canonical bytes.

Years are integer 1900–2200, with future actuals rejected against the current UTC year. Current-year figures may be provisional. Numeric magnitude is at most 10^15; counts are integers, annual average population permits six decimal places. Nonnegative counts and signed balances retain their distinct domains. Up to 301 changes/points, 500 revisions per room/metric, 262 KiB per full team material and 32 MiB of team material history per room are allowed. Existing 1 MiB live-snapshot and 8 MiB frozen-snapshot bounds still apply; a limit error rolls back the complete command. History pages are metadata-only and material is retrieved on demand. SQL does not silently recompute natural change or migration balance from other metrics: inconsistencies remain visible for the team's explicit decision.

Money is an integer number of kopecks. Quantity is a canonical decimal string with at most three fractional digits; unit price is integer kopecks, periods is an integer. Line cost uses exact numeric arithmetic and half-up rounding to a kopeck. Funding allocations are separate from costs. Their combined amount cannot exceed the cost; in-kind rows cannot receive cash allocations. Confirmed prices and funding require their respective source and source date. An application/assumption does not reduce the confirmed funding gap. Cost changes that invalidate allocations are rejected instead of silently redistributing money.

## Frozen versions and projections

A capture stores the exact territory edition, all typed rows and grounds including archived records, canonical statistical series, calculation parameters, exact budget and complete immutable regional evidence referenced by every captured link. The server JSONB text is returned as `canonicalJson` with UTF-8 SHA-256. The parser verifies that its parsed value agrees with `snapshot`; the exporting client recomputes the byte hash before creating files. Later edits, source changes or reviews cannot update the stored version bytes. A teacher review is a separate record. `draft` and `submitted` are educational states and do not certify official adoption or a causal demographic effect.

The normal room is bounded by 1 MiB; a frozen version including full evidence by 8 MiB, all versions of a room by 128 MiB. At most 30 versions are retained. Per room, including archived row slots: 40 activities, 20 indicators, 20 scenarios, 100 costs, 200 funding allocations, 30 risks, 20 facts and 40 bases. These are implementation bounds, not throughput benchmarks.

Realtime sends minimal INSERT notifications in public.dw_roadmap_events. The small index exposes each room revision and a source cursor. A change in another room does not require reloading unchanged selected-room content. Relevant Stage 4 source or membership/status changes update the source cursor; anonymous submissions never do. The projector returns a separate DTO without account IDs, profile lists, raw survey answers, invitations or receipt secrets. Plain authored text is not automatically anonymized.

All persistence tables are private and have RLS enabled with no direct API-role grants. Public functions are SECURITY INVOKER wrappers around guarded private handlers with an empty search_path. The administrator imports/validates/seals canonical datasets; writes never accept a client's proposed authority or a secret key. Previous migrations and the independent survey entry remain unchanged. PGlite tests exercise real SQL but do not certify hosted SMTP/Auth/PostgREST/Realtime, independent-connection concurrency or workload capacity.
