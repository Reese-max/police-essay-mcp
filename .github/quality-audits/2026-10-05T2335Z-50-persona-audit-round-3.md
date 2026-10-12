# police-essay-mcp — Fixed 50-Persona Audit Round 3

Run: `2026-10-05T23:35Z`
Scope: fixed A01–J05 synthetic personas; this is scenario simulation, not human research or 50 independent validations.

## Protocol / inspected state

- Fixed persona protocol blob: `6e3499d6ef5be7e123050e1526946f6a40f99263` (`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`).
- Issue Quality v2 blob: `8167e10798071d2276addaff6b201c6b0e904a2a` (`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-14-issue-quality-v2.md`).
- Default branch: `main`.
- Inspected HEAD: `2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83` (merge of PR #11). This round's report commit is audit-only on top of this product state; no product code was modified by this audit.
- Owner-approved direction re-read: keep the product local-first and narrow around Taiwanese civil-service/police essay editing, deterministic A4 two-page/44-line layout, and DOCX/PDF/TXT export; secure remote/tunnel use before connector expansion; verify real renderer/export and first-success journeys. Do not expand into OCR, grading, LMS, cloud sync, multi-user collaboration, marketplace, or generic IAM.
- Owner inventory via this round's credentials returned **23 Reese-max-owned repositories, 0 archived**. Prior rounds reported 42 and 38; the visibility gap between credential contexts is retained as a caveat and is not evidence of deletion or exclusion.
- Remote branches at inspection: `main`, `codex/fix-export-filename-isolation`, `codex/issue-3-http-concurrency`, `feat/answer-sheet-widget`, `feat/issue-4-export-artifact`, `fix/issue-1-ci-test-discovery`, `fix/issue-1-http-mcp-auth-20260926`, `test/issue-3-atomic-version-regression`.
- Open PRs: #5 (`feat/answer-sheet-widget`, draft WIP) only. It is outside current default product scope and was not modified.
- Issues on current default: #1 open (P1 remote/tunnel auth — reopened as a verification follow-up after PR #7 merged), #3 closed, #4 closed; #2 is this fixed-50 umbrella.
- Comments for #1 were re-read. The owner reopened #1 on 2026-09-29 as a verification follow-up requiring (1) an isolated real HTTPS tunnel / ChatGPT connector credential receipt and (2) a GitHub Actions run that actually executes. Item (2) now exists; item (1) remains outstanding.
- GitHub Actions exact-head receipt now exists: push run `37261052913` on `2cf3da1` concluded **success**; `verify (20)` (runner_id 1000015376) and `verify (22)` (runner_id 1000015377) each executed real steps — `npm ci`, `npm run check`, `npm test`, `npm run build` — and the Node 20 job additionally executed `npm run test:render` with LibreOffice, poppler and Noto CJK installed. The zero-step admission failures seen in earlier rounds are resolved for this HEAD.
- This round performed a real local checkout at `2cf3da1` and executed the suite (receipts below). Prior rounds audited source only.

Commit-fixed evidence (inspected HEAD `2cf3da1`):

- README: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/README.md
- HTTP/stdio entry: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/src/index.ts
- MCP tools + export resource: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/src/server.ts
- storage/version serialization + export artifact handles: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/src/storage.ts
- layout: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/src/layout.ts
- exporters: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/src/exporters.ts
- layout/concurrency tests: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/tests/layout.test.ts
- HTTP integration tests: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/tests/mcp-http.test.ts
- HTTP security tests: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/tests/http-security.test.ts
- CI workflow: https://github.com/Reese-max/police-essay-mcp/blob/2cf3da1cc1d58b8dc3cfb4c29a0db98a4b914e83/.github/workflows/ci.yml

## Executed runtime receipts (new this round)

Local isolated checkout of `2cf3da1`, Linux x86_64, Node `v24.10.0`, npm `9.2.0` — all commands exited 0:

| Command | Exit | Receipt |
|---|---|---|
| `npm ci` | 0 | 141 packages installed, 0 vulnerabilities |
| `npm run check` | 0 | `tsc --noEmit` clean |
| `npm test` | 0 | 22 tests, 22 pass, 0 fail (`node scripts/run-tests.js` → `node --import tsx --test tests/*.test.ts`) |
| `npm run build` | 0 | `tsc -p tsconfig.json` emitted `dist/` |
| `REQUIRE_DOCX_RENDER=true npm run test:render` | 0 | PDF 2 pages rendered via `pdftoppm`; DOCX 2 pages rendered via headless LibreOffice → PDF → PNG; page count, A4 ratio and non-blank assertions passed |

Executed test coverage directly relevant to prior findings:

- `HTTP rejects missing credentials at startup even when a tunnel targets loopback` — pass (covers `HOST=127.0.0.1` + no token, `HOST=0.0.0.0` + no token, and `0.0.0.0` + anonymous-loopback misuse).
- `owner and read credentials enforce the HTTP boundary before storage` — pass (401 for missing/wrong bearer on GET/POST/DELETE; read token gets read-only tool surface; storage untouched by denied calls).
- `anonymous loopback requires explicit opt-in and never enables browser origins by default` — pass.
- `independent HTTP MCP clients cannot overwrite the same accepted answer version` — pass (cross-process HTTP concurrency, the #3 fixture).
- `concurrent exports sharing a filename retain each answer's immutable artifact` — pass.
- `export artifacts are owner-only opaque resources with bytes, MIME, and expiry` — pass (#4 contract).
- `FileStore keeps a second stale writer outside the first writer's version read` / `does not block a different answer while one write is paused` — pass.

## Delta / finding decisions

### #1 P1 remote/tunnel owner-auth boundary — SOURCE FIX EXECUTED on current default; issue open for owner disposition

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/1

The original fingerprint is closed on current default. `validateRuntimeConfig()` now throws when HTTP mode runs without `MCP_AUTH_TOKEN`, on **every** host including `127.0.0.1`, unless `MCP_ALLOW_ANONYMOUS_LOOPBACK=true` is explicitly set — and that mode itself refuses non-loopback `HOST` and refuses to combine with tokens. `MCP_ALLOW_ANONYMOUS_REMOTE=true` is disabled outright. `tokenMatches()` returns false when no expected token is configured; `requestScope()` requires a Bearer credential before any MCP transport handling; an optional `MCP_READ_TOKEN` yields a read-only tool surface with mutation/export tools removed at registration and the export-artifact resource denied. CORS accepts only an exact configured origin.

Executed evidence: all six cases in `tests/http-security.test.ts` passed locally and inside exact-head CI run `37261052913`, including the loopback-no-token fail-closed startup that was the supported tunnel fingerprint.

Residual boundary, honestly stated: `MCP_ALLOW_ANONYMOUS_LOOPBACK=true` remains an honored explicit configuration; a tunnel fronting that mode inherits no product-layer credential check. It is documented as only for no-tunnel/no-proxy local use, but the product cannot distinguish a proxied loopback request from a local one. The owner's remaining stated acceptance item — a live HTTPS tunnel / ChatGPT connector receipt exercising missing/invalid/read-only/owner credentials — was **not** performed in this round; no external endpoint was exposed (out of audit scope).

Decision: `BUG / P1 / CONFIRMED / SOURCE_CONFIRMED` root cause corrected and executed-verified; the issue stays **open** per the owner's verification follow-up pending the live-tunnel receipt. No new issue filed.

### #3 P2 overlapping expectedVersion writes — VERIFIED_FIXED (closed)

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/3

`FileStore` serializes writes per `answerId` (`withAnswerWriteLock`), re-reads inside the lock, checks `expectedVersion` at commit time, and writes via UUID-suffixed temp files with atomic rename. Executed this round, locally and in exact-head CI: the two stale-writer fixtures in `tests/layout.test.ts` and the cross-client `tests/mcp-http.test.ts` concurrency test. The original single-process root cause is corrected with an executed receipt. Issue is closed; classification upgraded from `NEEDS_RUNTIME_VERIFICATION` to `VERIFIED_FIXED` for the supported single-process scope. Multi-process/distributed coordination remains out of scope by design.

### #4 P2 remote export retrieval — VERIFIED_FIXED (closed)

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/4

`export_docx` / `export_pdf` / `export_text` now return a filename-free random `exportUri` (`essay://exports/<uuid>`) plus a `resource_link`; a registered MCP resource serves the bytes under a 24-hour TTL manifest. `createExportHandle`/`readExport` enforce realpath containment inside the export root, UUID handle validation, immutable per-answer artifact copies under a per-filename export write lock, and owner-only access (read credential denied at resource level). Executed this round, locally and in exact-head CI: `export artifacts are owner-only opaque resources with bytes, MIME, and expiry` and `concurrent exports sharing a filename retain each answer's immutable artifact`. Classification upgraded to `VERIFIED_FIXED`. Issue is closed.

### Rejected / deferred candidates in this round

- Real Word/desktop viewing, phone viewport, print path and assistive-technology consumption of generated artifacts remain `VALIDATION_GAP / NOT_ESTABLISHED`. The new LibreOffice headless + pdftoppm render regression is a real renderer receipt (2-page A4-equivalent output) but is not a human-viewer receipt.
- macOS PDF CJK font discovery: still no macOS font candidate in `findPdfFont()` (Windows + Linux paths only); remains `LIKELY / VALIDATION_GAP / NOT_ESTABLISHED` until an isolated macOS export demonstrates actual glyph failure. No issue manufactured.
- Timeout/5xx/response-loss failure injection around mutations and exports remains unexecuted — kept as a future scenario, not a filed defect.
- Soak/retention/large-payload benchmarks absent; schemas/body limits bound inputs but no load evidence is claimed.
- Widget PR #5 is draft WIP outside current default; its scope was not touched.
- Repository inventory visibility differs across credential contexts (23 vs prior 38/42) — retained caveat, no inferred deletion.
- No generic undo/history, cloud storage, identity system, multi-user collaboration, or broad renderer framework is justified by this round.

## Fixed A01–J05 Round-3 matrix

Evidence codes: `SC` = source-confirmed; `SI` = static inference; `EX` = executed receipt this round (local suite or exact-head CI); `NRV` = needs runtime verification; `CV` = cannot verify executed outcome. A source property marked pass is not a runtime pass; `EX` receipts are on inspected HEAD `2cf3da1`.

| Persona | Goal / prerequisite | Round-3 steps | Expected | Current observation | Evidence / grading | Finding |
|---|---|---|---|---|---|---|
| A01 | first-time mobile, ChatGPT-first | follow documented tunnel path, create, edit, export | safe first success and downloadable file | HTTP refuses startup without owner token on any host; export returns retrievable `exportUri` artifact | SC + EX / P1 fixed-in-source, live tunnel receipt pending | #1 |
| A02 | Docs-familiar, no CLI | remote create/read/format/export | finish without host filesystem | artifact resource returns bytes/MIME via `resources/read` | SC + EX | #4 fixed |
| A03 | CS student, CLI-capable | stdio create → preview → edit → layout | deterministic local loop | stdio entry exercised in executed tests; check/test/build green | EX | — |
| A04 | time-pressured examinee | fill exactly 44 lines, compress overflow, export | quick exact fit and final artifact | 44/45-line fixtures executed; export artifact retrievable | EX | — |
| A05 | visual learner | read pageUsage/compressionHints after edits | visible line state | structured layout report exists; real client rendering unverified | SC + NRV | — |
| B01 | non-programmer office user | README local start then optional tunnel | shortest safe path | local path clear; tunnel path now fails closed unless token set | SC + EX | #1 fixed-in-source |
| B02 | junior engineer | install, check, test, recover | executable verification | `npm ci`/`check`/`test`/`build` all executed exit 0; exact-head CI green | EX | — |
| B03 | reversible formatting user | two same-version edits in overlap | one commit, one conflict | per-answer lock + commit-time version check executed | EX | #3 fixed |
| B04 | research assistant | structured answer → DOCX/PDF/TXT | traceable retrievable artifact | bounded artifact handle returned and read back in test | EX | #4 fixed |
| B05 | mobile/shift user | continue away from server host | owner-only remote use and file retrieval | auth enforced at startup/request; artifact handoff implemented; live tunnel receipt pending | SC + EX / residual | #1 |
| C01 | police/public-sector accuracy | concurrent revision of one answer | accepted change cannot silently disappear | cross-client overlap test executed: exactly one commits | EX | #3 fixed |
| C02 | teacher, low learning cost | list/reopen multiple answers | predictable saved-state workflow | list/read/persistent JSON paths present | SC + NRV | — |
| C03 | security-sensitive | expose connector through HTTPS tunnel | owner auth before any answer tool | no-token startup refused incl. loopback; bearer enforced before MCP handling | SC + EX; live tunnel NRV | #1 |
| C04 | long-flow creator | repeated preview/write with occasional overlap | version conflict instead of overwrite | executed concurrency fixtures | EX | #3 fixed |
| C05 | SRE | inspect startup/auth/body-limit/timeout | fail closed and observable receipts | fail-closed startup, 401/403/413 paths and CI receipts executed | EX | — |
| D01 | manager | list answers/check layout summaries | concise status | structured outputs exist | SC | — |
| D02 | PM | inspect version across overlapping edits | monotonic authoritative version | commit-time expectedVersion executed | EX | #3 fixed |
| D03 | IT admin | configure reverse tunnel | explicit security boundary | auth mandatory by default on every HTTP host | SC + EX | #1 fixed-in-source |
| D04 | cost-sensitive operator | run core flow locally | no paid provider dependency | no required paid model/service in repo core | SC | — |
| D05 | compliance/audit | remote list/read/mutate/export | authorization and traceable output | owner/read scopes enforced; artifact access owner-only | SC + EX | #1 residual: anonymous-loopback opt-in |
| E01 | traditional office user | local create and DOCX export | usable office handoff | DOCX rendered via LibreOffice headless in render lane | EX (headless) + NRV (real Word) | — |
| E02 | larger-text desktop user | open/zoom DOCX/PDF | stable readable layout | render receipts cover pagination, not zoom/readability | NRV | — |
| E03 | low digital familiarity | stale/repeated edit | clear conflict, no silent overwrite | executed stale-writer rejection | EX | #3 fixed |
| E04 | cloud-unfamiliar | stdio or loopback only | remain local | stdio/loopback supported; anonymous loopback is explicit opt-in | SC + EX | — |
| E05 | long reading session | review two-page grid | stable output | deterministic grid executed; viewer fatigue/readability unverified | EX (grid) + NRV (viewer) | — |
| F01 | senior first-time user | remote ChatGPT create/export | file arrives in client | artifact resource contract executed; live connector receipt pending | EX + NRV connector | #4 fixed, #1 residual |
| F02 | low vision | zoom final artifact | perceivable content | no AT/zoom receipts | NRV | — |
| F03 | low motor precision | use external MCP client controls | no repo-owned fine-pointer blocker | tools are non-pointer API; client UX unverified | NRV | — |
| F04 | memory-load sensitive | stop/reopen saved answer | current state recoverable | persistent answer JSON + list/read exist | SC + NRV restart | — |
| F05 | assisted setup then self-use | helper configures server; user later remote | safe repeatable access | token required by default; artifact handoff implemented | SC + EX | #1 fixed-in-source |
| G01 | keyboard-only | operate through MCP client | keyboard-completable path | repo exposes non-pointer API; client behavior unverified | NRV | — |
| G02 | screen reader | consume structured answer and export | meaningful output order | structured text exists; DOCX/PDF AT receipts absent | NRV | — |
| G03 | color-vision limitation | interpret state/errors | text/non-color status | tool outputs/errors are textual/structured | SC + EX | — |
| G04 | 200% zoom/narrow screen | remote export then view | task survives narrow device | artifact retrievable remotely; viewer validation absent | EX + NRV | #4 fixed |
| G05 | slow/high-latency network | delayed/retried mutation and export | deterministic conflict/recovery | same-answer serialization executed; injected timeout/loss not executed | EX + NRV | #3 fixed |
| H01 | Windows developer | generate Chinese DOCX/PDF | readable output | Windows font candidates present; executed render was Linux/Noto | SI + EX(Linux) + NRV(Win) | — |
| H02 | macOS developer | export Chinese PDF without custom font | readable glyphs | still no macOS font candidate; actual fallback failure unexecuted | NOT_ESTABLISHED + NRV | deferred |
| H03 | Linux/CI non-interactive | npm check/test/build | repeatable headless verification | executed locally and on exact-head CI (Node 20/22) | EX | — |
| H04 | self-host/tunnel operator | publish MCP and retrieve exports | auth + bounded artifact channel | both enforced in source and executed tests; live tunnel pending | SC + EX | #1, #4 fixed-in-source |
| H05 | first-time maintainer | read docs/source/tests | clear contract and bounded fix scope | docs/source/tests coherent; suite executed green | SC + EX | — |
| I01 | resend/duplicate click | two overlapping expectedVersion=N writes | exactly one commits | executed cross-client fixture | EX | #3 fixed |
| I02 | restart then resume | reopen saved answer | persisted state returns | file persistence exists; crash/restart not executed | SI + NRV | — |
| I03 | malformed input/id | send invalid IDs/oversized fields | reject without corruption | zod/safeId/body-limit guards exist; 413 path executed | SC + EX(partial) | — |
| I04 | timeout/5xx | lose response around mutation | authoritative state can be re-read safely | re-read/versioning exists; injected timeout/retry not executed | SI + NRV | #3 adjacent |
| I05 | partial success then retry | export succeeds but response path breaks | recover exact artifact | immutable artifact copy + handle allow re-read within TTL | SC + EX | #4 fixed |
| J01 | large input | many sections/long text | bounded cost and deterministic rejection | schema/body bounds exist; no scale benchmark | SC bounds + NRV perf | — |
| J02 | parallel operation | same-answer vs different-answer writes | serialized vs independent | executed: same-answer serialized, different-answer non-blocking | EX | #3 fixed |
| J03 | long-running use | repeated saves/exports | no corruption/resource leak | atomic replace + per-answer lock; soak/retention absent | NRV | — |
| J04 | privacy/security-sensitive | remote tunnel list/read/mutate | owner-only | auth mandatory by default; anonymous loopback is explicit opt-in | SC + EX | #1 fixed-in-source |
| J05 | expert automation | preview/edit/check/export with concurrency | composable, safe, remotely complete | structured API + executed concurrency/artifact/auth tests; live connector receipt pending | EX + NRV | #1, #3, #4 fixed-in-source |

## Ten required dimensions — Round-3 result

1. **First understanding / first success** — README documents auth-required setup; remote first-success is now completable via `exportUri` artifacts; the live tunnel/connector journey remains unexecuted.
2. **Core task** — create/read/preview/edit/layout/export covered by executed tests including exact 44-line capacity and overflow hints.
3. **Error recovery** — expectedVersion conflicts enforced at commit time under the per-answer lock; executed locally and in CI.
4. **Data safety** — atomic rename writes, per-answer serialization, immutable export artifacts with containment checks; remote owner authorization enforced by default (#1 fixed-in-source).
5. **Observability** — health/readiness, structured errors, and now real exact-head CI receipts plus a local executed suite; green on `2cf3da1`.
6. **Accessibility / device** — still the weakest dimension: no real keyboard/screen-reader/zoom/phone/print receipts; headless LibreOffice/pdftoppm render is the only executed renderer evidence.
7. **Performance / cost** — request/body/schema bounds exist; no paid dependency; no load/soak benchmark claimed.
8. **Maintainability** — compact typed code, focused tests, real CI; fixes stayed narrow around their findings.
9. **Failure injection** — body-limit, auth and concurrency negatives executed; timeout/response-loss/5xx injection and renderer-absence runs still missing.
10. **Trust** — remote ownership is now fail-closed by default and artifacts are retrievable; remaining trust gap is the absence of a live-tunnel receipt and the honored anonymous-loopback opt-in.

## Runtime evidence boundary / next safe checks

Executed this round: local `npm ci`/`check`/`test`/`build`/`test:render` on `2cf3da1` (all exit 0) and exact-head CI run `37261052913` including the LibreOffice/pdftoppm render lane. Not executed: live HTTPS tunnel or ChatGPT connector session, real Word/desktop viewer, mobile viewport, print path, assistive technology, timeout/5xx/response-loss injection, crash/restart, soak benchmarks, and any production-data or destructive operation. Bounded next checks:

1. Isolated real tunnel/connector receipt for #1: missing, invalid, read-only and owner credentials against a disposable instance — the issue's stated remaining acceptance item.
2. Real Word/desktop + phone/narrow-viewport + print rendering of the fixed 44-line fixture; record pagination/line-grid differences.
3. macOS export with no configured CJK font to establish or retire the deferred font-fallback candidate.
4. Failure-injection fixtures for timeout/response-loss around mutation and export retry.

## CLEAN status

**NOT CLEAN — 0/2 qualifying clean rounds.**

Reasons:

- #1 remains an **open** P1 tracker item: the root cause is source-fixed with executed regression evidence, but the owner's reopened verification follow-up still requires a live tunnel/connector credential receipt that this round did not produce.
- Required runtime evidence is materially improved but still incomplete: accessibility/device/print/failure-injection receipts are absent.
- Portfolio-level caveat retained: repository inventory visibility differs across credential contexts (23 here vs 38/42 previously).

This is nevertheless the first fixed-50 round on this repository with executed local and exact-head CI receipts, and all three historical actionable findings (#1 source, #3, #4) are corrected on current default with passing executed tests. If the owner accepts the #1 verification evidence and closes it, the next complete round with no new applicable P0/P1/P2 findings and the remaining runtime receipts could begin the qualifying-round streak.

## Coordination / writes

- No product code, CI/config, settings, secrets, permissions, branch protection, merge, deploy, GOAL, worker or paid/external write was started by this audit.
- No issue mutation was performed; #1/#3/#4 dispositions above are recommendations for owner review, not tracker changes.
- This report is the only artifact of this round and is audit-only on top of product HEAD `2cf3da1`.
