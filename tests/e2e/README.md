# Stage 1: real Chromium browser verification

The flow under test is: initial Mordovia document → full-document search or prepared practice → exact source quotation → explicit field review → save → reload → persisted result. A separate real ZIP download is opened and its data checked. The mobile case uses Chromium at 390 × 844 with touch emulation; it is not a Safari, iOS-device or Android-device certification.

The Browser plugin is not available in this session. These tests use the explicitly requested regular Playwright runner and a supplied Chromium executable. No route interception, response mocks, fake backend, injected application state, direct IndexedDB writes or fabricated DOM selection is used. Every saved annotation is created by visible application controls.

One dedicated negative-path test deliberately overrides the public `IDBObjectStore.prototype.put` method **after successful initial loading** to throw a `QuotaExceededError`. It verifies that saving through the UI actually reaches this failing API, restores the original property descriptor in a `finally` block, and reloads against the real IndexedDB database. This is controlled browser-API fault injection, not exhausted physical disk space, a fake backend, prewritten test records or fabricated application state. The other seven scenarios use the unmodified browser storage API.

## Run

From the repository root:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npm run test:e2e
```

`playwright.config.ts` starts `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort` in the same invocation when `http://127.0.0.1:4173` is not already reachable. This is necessary in environments where separate command sessions have isolated network namespaces. A separately started server is not required. If the executable variable is absent, Playwright uses its normal installed Chromium.

The only added launch arguments are `--no-sandbox`, `--disable-dev-shm-usage` and `--disable-gpu`. Web security remains enabled; no Sparticuz argument bundle is imported.

Screenshots, traces and downloaded ZIPs go outside the repository. The default directory is the system temporary directory's `demography-workshop-playwright`; override it with `PLAYWRIGHT_ARTIFACTS_DIR`. For example, set that variable to a scratch `research/stage-one-e2e` directory. The reporter is textual; no HTML report is created.

## Assertions

| Case | Actual browser assertions |
|---|---|
| Initial document and search | Correct page title, meaningful first screen, Mordovia selected, 80 prepared texts, 137 pages; a query absent from the initial rendered page finds the real p. 59 fragment and opens `#page=59` in the original-source link. |
| Practice, quotation and persistence | A prepared Mordovia card opens its source; selecting the actual block and confirming only the recipient field enables saving; exactly one field is marked checked; the saved quotation and field review remain after a real browser reload. |
| ZIP download | An actual browser download completes; the archive contains valid JSON and README, the exact saved quote and source edition/hash; a profile entered through the UI is excluded. |
| Mobile Chromium | Reader, library and evidence tabs work at 390 px; touch selection leads to the correct card; document/body scroll widths stay within the viewport on each panel. |
| Archive import | A ZIP exported after an actual verified field review is selected through the file chooser in a fresh BrowserContext; source selectors remain identical while decision and field verification become candidate. |
| Two tabs | Two pages of one real browser context observe each other’s committed quotations without reloading; both records survive a later reload through the real IndexedDB store. This checks same-browser notifications, not server multiplayer. |
| Keyboard modal | Enter opens the card dialog; Tab/Shift+Tab stay inside it, disabled Save is skipped, newly enabled Save joins the focus loop, Escape restores focus and scrolling. |
| IndexedDB quota failure | After successful bootstrap, an injected `QuotaExceededError` makes a profile save fail; the alert and red/textual footer state are visible, input values remain, no success message appears, and a reload after restoring the API shows that the unsaved profile was never committed. |
| Every case | No uncaught browser error, console error or Vite error overlay. Console warnings, if any, are attached for review rather than silently discarded. |

Each test starts in a fresh browser context. The real corpus and application's local storage layer are exercised. The pinned seed practice and paragraph 604 on page 59 are intentional source fixtures; a deliberate corpus-edition change may require updating the expected human-accessible fragment label.

These checks do not claim backend synchronization, authentication, cross-device persistence, all-browser coverage or PDF availability on third-party servers. Remote PDF links are checked without downloading the original corpus.
