# Stages 2–4: collaboration verification

The flow under test is: email code → named profile → teacher creates a session → a second clean browser context joins → a participant checks an actual source fragment → publishes the practice → the teacher sees it without reloading → both clients retain the shared work after reloading. A separate host projector uses the dedicated projection RPC.

The Browser plugin is not available in the implementation environment. The browser suite uses the repository's Playwright runner with Chromium. The mobile case is a 390 × 844 Chromium viewport with touch emulation; it does not certify Safari, iOS hardware, Android hardware or every browser.

## What is real and what is a fixture

| Boundary | What the checks exercise | What the checks do not establish |
| --- | --- | --- |
| UI | Real React application, visible forms and buttons, separate BrowserContexts, actual local corpus and IndexedDB | Hardware touch behavior or broad browser compatibility |
| SDK | The pinned `@supabase/supabase-js` package over actual HTTP, including `signInWithOtp`, `verifyOtp`, persisted sessions and RPC | Compatibility with every hosted GoTrue/PostgREST release |
| Database | All shipped SQL migrations running in PGlite, `SET LOCAL ROLE authenticated`, server-derived JWT claims, actual canonical blocks for Mordovia, Perm Krai, Tambov Oblast and Sakhalin Oblast | Hosted Supabase deployment, PostgreSQL infrastructure configuration, production load or network latency |
| Authentication transport | Local fixture codes, expiring signed fixture tokens accepted only if issued by the fixture server, separate user identities | Email delivery, SMTP rate limits, anti-abuse controls, CAPTCHA, real provider verification or recovery |
| Shared updates | Real HTTP polling from independent browser contexts against the same SQL database; idle polls fetch only the scalar event cursor | Hosted Supabase Realtime/WebSocket delivery or reconnection |
| Projector | Dedicated `dw_projector_snapshot` payload and rendered view, no account email, membership identifiers or admission code in that payload | Anonymous public broadcast; projector access still requires the host's authenticated browser |

The fixture gateway is not a production backend or a Supabase replacement. `scripts/test-collaboration-gateway.mjs` refuses to start without `WORKSHOP_TEST_GATEWAY=1` and a runner secret of at least 32 characters. It binds only `127.0.0.1`, accepts CORS only from the configured exact loopback app origin and an explicitly configured second survey origin, and accepts only four reserved `workshop.test` addresses for named authentication. It never sends email. OTP retrieval and database reset require a separate runner secret; those routes reject every request carrying a browser Origin, including either allowed application Origin. That secret is not passed through a `VITE_` variable or included in browser assets.

The HTTP adapter exposes an explicit allowlist of `dw_` functions and only their declared named arguments. SQL values are parameterized. UUID-array arguments are validated and transmitted as one PostgreSQL parameter; JSON arguments remain JSON. Each SQL call runs in its own transaction after the fixture's issued-token map resolves the user; claims never come from a caller's JSON body or an unverified JWT payload. The queue prevents concurrent requests from sharing a database connection's claims. Competing requests exercise stale revisions against committed writes; this single-connection fixture does not certify PostgreSQL lock behavior under production parallel load. Row and mutation authorization remains the responsibility of the actual migrations, which are tested rather than imitated in JavaScript.

## Commands

From the repository root, after `npm ci`:

```bash
node --test tests/collaboration/gateway.integration.test.mjs
```

This command starts its own loopback gateway on an ephemeral port and runs the real SDK against it. The runner resets the PGlite fixture before each case.

For the real browser flows:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npx playwright test --config playwright.stage-two.config.ts
```

The Playwright configuration starts the fixture gateway and Vite as children of the same invocation. This matters in environments where separate command sessions have isolated network namespaces. It sets the app's explicit test configuration, uses the reserved fixture publishable key, and disables hosted Realtime so the actual polling fallback is exercised. The teacher and participants request their codes through the application; only the test runner retrieves them from the fixture's protected channel before typing them into the visible form.

Screenshots and traces go outside the repository. `PLAYWRIGHT_ARTIFACTS_DIR` can override the default system temporary directory. Chromium receives only `--no-sandbox`, `--disable-dev-shm-usage`, and `--disable-gpu`. Browser web security is not disabled.

## Security and consistency cases

The HTTP SDK suite covers OTP replay and forged bearer rejection, profile and host authorization, creating and joining sessions, exact source publication, readback through a new client, session isolation, foreign-record moderation, operation idempotency, stale revisions, pause/resume, canonical text tampering, unknown source editions, observer restrictions, membership revocation, invitation rotation, the separate projector DTO, strict CORS, and fixture-only email addresses.

The browser suite checks user-visible behavior and independent contexts. Its fixture identities are synthetic. It does not intercept application network routes, substitute RPC responses, inject workspace records, write application storage directly, fabricate DOM selections, or imitate successful writes. An actual hosted staging run with the intended Supabase project and mail provider remains necessary before claiming that SMTP, hosted Realtime and production deployment have been verified.

The revision-conflict browser case intentionally submits a stale revision from a second independently authenticated context. Exactly that real SQL rejection is expected to return HTTP 400; the test checks the `REVISION_CONFLICT` response, the preserved unsaved text, and the unchanged version on the teacher's board. Its corresponding browser network error is classified as expected. Uncaught runtime errors, overlays, other failed requests and unrelated console errors remain failures.

| Browser case | User-visible assertions |
| --- | --- |
| Independent teacher and participant | Actual email-code forms and names, host-only creation, invitation-based joining, real Mordovia paragraph 604 on page 59, explicit recipient-field review, publication, teacher readback without reload, source return, reload of both clients and pause/resume |
| Idle traffic | Two actual completed `dw_session_cursor` polls after the board settles; no repeated `dw_session_snapshot` request while the event cursor is unchanged |
| Projector | Separate window with a session identifier only, dedicated projection RPC, no full membership snapshot or invitation fetch, hidden authors by default, live focus and explicit author display |
| Mobile | 390 × 844 touch-emulated Chromium, authentication, joining, prepared-card publication, source return and strict horizontal-overflow checks |
| Revision conflict | Two separate authenticated browser contexts for the same author, two concurrently open editors, one committed change, an actual rejected stale write, preserved draft and unchanged shared result |

## Stage 3: map, curation and voting

The Stage 3 flow under test is: separate participants select a real region shape → one claims the program → a review is completed with either a real publication or an explicit explanatory note → the teacher compares and groups published Mordovia and Sakhalin variants → a blinded round records independent responses → a dedicated projector reveals the aggregate result after closure → a later round starts with no inherited votes.

The gateway imports all migration files in filename order through the shared database harness. It seeds the four unchanged regional editions used by the prepared practice collection, with canonical hashes and sealing, including the distinct kindergarten compensation variants from Mordovia and Sakhalin. This fixture coverage is deliberately narrower than the complete 80-edition release corpus.

The combined SDK and HTTP suite is run with:

```bash
npm run test:collaboration
```

`gateway.integration.test.mjs` contains the nine Stage 2 cases. `workshop.integration.test.mjs` adds nine Stage 3 cases. The new cases exercise region claims and stale revisions, explanatory completion notes, preservation of original fields and citations during grouping and moves, workshop/source-board cursor separation, hidden totals, explicit neutral versus absent answers, 100 retries of one ballot operation, immutable rounds and source bundles, fresh-round voting, late joining and revocation, captured ranking thresholds and zero denominators. A separate compact-response case checks known, missing and wrong round cache identifiers, a new round, replaying an operation with a changed cache hint, aggregate disclosure after closure, and projector authorization/privacy.

The Stage 3 browser suite is run with:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npx playwright test --config playwright.stage-three.config.ts
```

The Stage 2 configuration is scoped to `stage-two.spec.ts`; the Stage 3 configuration is scoped to `stage-three.spec.ts`. Each starts its own isolated fixture gateway and Vite server. The full source workflow uses real UI controls and HTTP calls; the test runner retrieves only fixture OTP codes from its restricted channel. No test writes application storage directly, injects a prebuilt session into React, replaces RPC results or fabricates a successful save.

| Stage 3 browser case | User-visible proof |
| --- | --- |
| Competing assignments | All 89 map controls exist; keyboard selection of actual SVG regions; two participant contexts submit competing claims; exactly one server commit; the other receives an actual stale-write rejection; completion without a publication requires a note; teacher readback and reload retain the result |
| Regional variants | Desktop comparison and grouping retain distinct compensation amounts; touch-emulated 390 px and 320 px participant views keep readable full-width row headings without horizontal overflow; the participant opens the original Sakhalin page 37 and Mordovia page 59 and completes a region after publication |
| Blinded and repeated voting | First round hides aggregates; neutral response survives reload; withdrawal restores no-answer state; +1 and −1 produce a visible 2/2 denominator and a zero net score; projector uses dedicated restricted RPCs; the next round starts with no answers and the previous round remains readable |
| Curation interaction and conflict | Native mouse-pointer drag opens a confirmation form; keyboard transfer provides an alternative; removal preserves the source variant; two teacher contexts edit the same family and the rejected stale form retains its draft |

Expected conflict responses are allowlisted only for the RPC under direct test, and their actual SQL error codes are asserted. Uncaught JavaScript errors, error overlays, unrelated console errors and other failed HTTP responses remain failures. Projector checks reject session invitation codes, account emails and author names in the rendered result and reject full member/workshop snapshots on the projection read path. Frozen source bundles may contain arbitrary author-provided text; the tests do not claim automatic anonymization of that text.

The browser checks certify the exercised Chromium desktop and touch-emulated portrait flows. They do not establish physical touch-drag behavior, Safari/iOS, Android hardware, production concurrency, real SMTP, hosted Auth/PostgREST behavior, or hosted Realtime/WebSocket delivery. Map geometries are rendered from release data; the browser tests establish selectable and updated UI states, while geographic source matching and data integrity are checked separately.

## Stage 4: lifecycle barriers, evidence connections, author solutions and a separate survey

The Stage 4 flow is: participants formulate a named barrier and relate it to several lifecycle stages → discuss its significance → explain a connection to a curated practice family → retrieve the immutable regional source edition behind that connection → explicitly review it after the barrier, family or source publication changes → formulate an author solution with a first step, responsible party, resources, indicator and limitations. A voluntary survey runs through an independent entry and origin. Its raw answers are available only in the host's private review; creating a named public barrier starts a new blank generalization form.

```bash
node --test tests/collaboration/barriers.integration.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npx playwright test --config playwright.stage-four.config.ts
```

`barriers.integration.test.mjs` contains eleven SDK/HTTP/SQL scenarios. Named calls use the real Supabase SDK. Public calls use credential-free HTTP with the fixture publishable key. The browser cases exercise the actual `SurveyApi` used by the shipped standalone form. Successful RPC bodies are never substituted, and no private SQL table is modified through an auxiliary test HTTP endpoint.

The Stage 4 Playwright configuration starts the gateway and both Vite servers as children of the same runner. The classroom is `http://127.0.0.1:4173`, the separate form is `http://127.0.0.1:4174/survey.html`, and the gateway is `http://127.0.0.1:54321`. The configuration supplies `VITE_WORKSHOP_SURVEY_URL` and `VITE_WORKSHOP_CLASSROOM_ORIGIN` to both entries. Public survey dispatch in the fixture is enabled only when `WORKSHOP_TEST_SURVEY_ORIGIN` is explicitly configured; older Stage 2/3 configurations retain their named-only mode.

### Anonymous transport and database boundaries

The gateway exposes exactly four anonymous RPC names: `dw_survey_public_manifest`, `dw_survey_own_response`, `dw_survey_save_response`, and `dw_survey_withdraw_response`. A public request carrying only the publishable key runs the actual migration under `SET LOCAL ROLE anon`, with an anonymous JWT-role claim and no subject. A present bearer is always verified against the fixture's issued-token map. Invalid bearers receive HTTP 401; they are never downgraded to anonymous requests. A valid named bearer reaches the SQL function as `authenticated`, where the real anonymous-only guard rejects it. Host review, research export and named board mutations are excluded from anonymous dispatch.

Browser request inspection verifies that the standalone form does not call Auth, load the Supabase account SDK, send an account bearer or Cookie, include email/name/profile identifiers in its request bodies, or place its receipt secret in a URL. The shared invitation is carried in the fragment. The personal receipt has a separate secret and an invitation-free restore URL of the form `survey.html#survey=<id>`; the browser flow restores access from that receipt after invitation rotation and survey closure. Opening the standalone entry on the classroom origin is rejected before RPC or Auth calls.

The host client checks its invitation using the dedicated `dw_survey_invitation_state` DTO containing only `surveyId` and `invitationDigest`. The browser scenario asserts that no `dw_survey_host_state` request occurs until the host explicitly chooses “Просмотреть ответы”. The SDK scenario separately rejects anonymous, non-host and cross-session access to this invitation metadata.

### Verified behaviors exercised by the suites

| Stage 4 case | Assertions |
| --- | --- |
| Lifecycle and discussion | One primary stage with additional stages, confirmed pointer movement, an equivalent button action at mobile widths, author/host ownership, observer read-only access, private individual +1/−1/0/null values, aggregate counts, idempotency and preserved conflict drafts |
| Evidence connection | Native pointer connection and narrow-screen buttons; complete frozen Mordovia and Sakhalin bundles with different compensation amounts; exact original page 59 and page 37 jumps; stale barrier/family/publication revisions; stale links excluded from the UI's current-coverage filter; deliberate reconfirmation; prior immutable evidence retained after changes or deletion of the family |
| Author solution | Explicit barrier references and substantive fields; visible passport; author/host editing; observer restrictions; cross-session rejection; optimistic revision conflicts and revoked-membership rejection |
| Dedicated projector | Dedicated Stage 4 projection RPC; no full member/source-board snapshot or private survey retrieval on this read path; no account IDs, individual votes or raw answers; optional author display follows the session setting; survey projection contains only title, status and suppressed aggregate count |
| Public form and receipt | Separate origin even when the BrowserContext has a named classroom session; open text, perspective and optional intentions; editing a priority condition clears its old conditional assessment; voluntary research/quotation permission; one receipt updates one response; reload readback; receipt-only restoration after rotation/close; withdrawal clears text and old save retries cannot restore it |
| Host review and export | Exact private counts versus collective suppression below five responses; no raw survey answer automatically becomes a named barrier; blank explicit generalization; only current research consent is exported; separate quotation flag; downloaded ZIP has JSON, CSV, questionnaire and methodology notes; JSON retains the original text while CSV neutralizes formula-looking cells |
| Unavailable or deleted data | Invalid invitation and wrong receipt reveal no raw response; closed teaching sessions block new saves; expiry is exercised by the SQL suite with an administratively controlled retention date; purge blocks export and raw retrieval; withdrawal remains possible after close or purge; replay does not resurrect deleted content |

Six browser scenarios cover the user-visible boundaries above with desktop Chromium and touch-emulated 390 px and 320 px portrait views. They verify nonempty pages, absence of runtime errors and Vite overlays, actual resulting state and screenshots. They exercise real pointer actions and alternate controls; they do not infer physical touch compatibility from emulation. Proactive revision notices prevent an obsolete UI form from submitting until the participant explicitly accepts the current version; the SDK suite separately submits stale commands and checks the real SQL rejection.

The five records in the SDK suppression/export scenario are synthetic submissions made with five different receipt secrets. The tests intentionally do not claim that this establishes five unique people. The open-link procedure cannot establish one-person uniqueness, representativeness, a population prevalence of barriers or a causal demographic effect. Raw text may itself identify someone; no automated text anonymization is claimed. Infrastructure IP/user-agent/access logging, hosted anti-abuse behavior, production retention jobs and deletion of previously downloaded research files are outside this local fixture's proof.

The fixture still uses one serialized database connection. Invalidation, committed-state conflicts and role changes are real SQL behavior, but the suite is not a production concurrency or load test. Hosted Supabase Auth/PostgREST, intended-origin deployment, SMTP, browser-specific behavior and Realtime/WebSocket delivery need separate staging verification.

### Local execution record for release 0.4.0

On 2026-11-08 the cumulative SDK/HTTP/SQL command completed with 29 passing cases and zero failures: nine Stage 2, nine Stage 3 and eleven Stage 4 cases. The final Stage 4 browser run completed with all six cases passing, including the invitation-metadata gate and the actual native browser fetch transport. It produced sixteen scenario screenshots outside the release tree. The run used the pinned Supabase SDK and Playwright from the lockfile, Chromium with browser web security enabled, the two distinct loopback origins, and all current shipped migrations.

The source-connection, projector and receipt-restore screenshots were also visually inspected after the run. The exercised desktop and 390/320 px layouts retained readable controls without horizontal page overflow. This record refers to the local fixture boundaries stated above; it does not certify a hosted deployment or physical devices.
