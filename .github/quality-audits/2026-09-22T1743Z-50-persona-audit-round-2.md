# police-essay-mcp — Fixed 50-Persona Audit Round 2

Run: `2026-09-22T17:43Z`  
Scope: fixed A01–J05 synthetic personas; this is scenario simulation, not human research or 50 independent validations.

## Protocol / inspected state

- Fixed persona protocol blob: `6e3499d6ef5be7e123050e1526946f6a40f99263` (`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`).
- Issue Quality v2 blob: `8167e10798071d2276addaff6b201c6b0e904a2a` (`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-14-issue-quality-v2.md`).
- Default branch: `main`.
- Inspected pre-report HEAD: `ed7a905cf5e03fa053ab5ef20d63f032c12ad899`.
- Product-facing baseline: `92b10e3a20d21a0803176fdb67e551646fdd3696`; comparison `92b10e3... -> ed7a905...` adds only `.github/quality-audits/2026-09-20T1131Z-postfix-verification.md`, so the current HEAD is audit-only on top of the product baseline.
- Owner-approved direction re-read: keep the product local-first and narrow around Taiwanese civil-service/police essay editing, deterministic A4 two-page/44-line layout, and DOCX/PDF/TXT export; secure remote/tunnel use before connector expansion; verify real renderer/export and first-success journeys. Do not expand into OCR, grading, LMS, cloud sync, multi-user collaboration, marketplace, or generic IAM.
- Fresh owner inventory pagination in this run returned **42 Reese-max-owned repositories**: **41 unarchived + archived `obsidian-vault`**; the second page was empty.
- Branches at inspection: `main`, `feat/answer-sheet-widget`, `feat/issue-4-export-artifact`.
- All-state PRs: #5 is an open draft widget WIP; #6 is an open/unmerged remediation candidate for #4. Neither is current-product evidence and neither scope was modified.
- Open actionable Issues on current default: #1 P1 remote/tunnel auth, #3 P2 concurrent version-write verification, #4 P2 remote export retrieval; #2 is the fixed-50 umbrella.
- Full comments for #1/#2/#3/#4 were re-read. All historical persona/product-board lease markers are released; no current audit lease was found. No Issue mutation was needed in this round.
- Exact current-HEAD Actions run `35508287941` concluded `failure`; `verify (20)` failed and `verify (22)` was cancelled, both with `runner_id=0` and `steps=[]`. This is an admission/validation gap of unknown cause, not evidence that product tests executed and failed.
- GitHub-visible source re-read: README, package manifest, `src/index.ts`, `src/server.ts`, `src/storage.ts`, `src/layout.ts`, `src/exporters.ts`, `tests/layout.test.ts`, `tests/mcp-http.test.ts`, current Issues/PRs/branches, prior Round 1 and post-fix reports. GitHub does not expose a live local `autodev-ng status`/heartbeat receipt through this repository connector; no run/worker/GOAL was started.

Commit-fixed evidence:

- README: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/README.md
- HTTP/stdio entry: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/src/index.ts
- MCP tools: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/src/server.ts
- storage/version serialization: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/src/storage.ts
- layout: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/src/layout.ts
- exporters: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/src/exporters.ts
- layout/concurrency tests: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/tests/layout.test.ts
- HTTP integration test: https://github.com/Reese-max/police-essay-mcp/blob/92b10e3a20d21a0803176fdb67e551646fdd3696/tests/mcp-http.test.ts

The connector exposes full blobs but not stable line-number indexes for these files; this report does not invent line numbers.

## Delta / finding decisions

### #1 P1 remote/tunnel owner-auth boundary — PARTIALLY_FIXED / STILL_REPRODUCIBLE

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/1

Current source materially improves the old baseline: configured `MCP_AUTH_TOKEN` is checked before MCP transport handling; explicitly non-loopback `HOST` without auth fails startup unless anonymous remote is deliberately allowed; request size/timeout controls and configurable CORS exist. The original supported tunnel fingerprint is still reachable because auth-required behavior is decided from server `HOST`: default `127.0.0.1` permits no token, `tokenMatches()` returns true when no token is configured, while README still supports putting that loopback endpoint behind an HTTPS tunnel. The current HTTP integration test always starts loopback **with** a token and therefore does not close the tunnel-without-token condition.

Decision remains `BUG / P1 / CONFIRMED / SOURCE_CONFIRMED / NEEDS_REVIEW / auto_implementation=false`. No production tunnel, unauthorized access, data incident, or exploit was executed. Minimum remaining correction remains a narrow fail-closed remote/tunnel mode or equivalent enforced owner-auth boundary; no generic IAM expansion.

### #3 P2 overlapping expectedVersion writes — source correction present / CANNOT_VERIFY runtime

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/3

`FileStore` now serializes writes per `answerId`, re-reads current storage inside that lock, compares `expectedVersion` at commit time, and uses UUID-suffixed temporary files. The current `tests/layout.test.ts` defines the original race with two concurrent `expectedVersion=1` saves and requires exactly one success, one rejection, and stored version 2. That is strong source/test-definition evidence that the original single-process root cause has been corrected.

However, the exact current/recent Actions receipts contain zero executed steps, and this round did not run a local checkout. Therefore the regression outcome is **CANNOT_VERIFY / NEEDS_RUNTIME_VERIFICATION**, not `VERIFIED_FIXED`; #3 remains open. No distributed lock/database work is justified for the original single-process scope.

### #4 P2 remote export retrieval — STILL_REPRODUCIBLE on current default; active candidate PR not credited

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/4

Current `export_docx` / `export_pdf` / `export_text` output schema still returns a server-local `path`; `FileStore` resolves only local export paths; HTTP surface remains `/`, `/health`, `/readyz`, `/mcp`; current registered resources do not provide generated-artifact retrieval. Thus the remote ChatGPT handoff still stops at a host-local file.

PR #6 (`feat/issue-4-export-artifact`, head `7475d812f300f70fa20170c8395c7be09853d10c`) is open/unmerged and claims an MCP-native bounded export resource plus SDK integration tests. This is candidate evidence only. It is not counted as current-default behavior, and its active scope was not modified.

Decision remains `BUG / P2 / CONFIRMED / SOURCE_CONFIRMED / NEEDS_REVIEW / auto_implementation=false` on current default.

### Rejected / deferred candidates in this round

- PDF CJK fallback: source can fall back to Helvetica when no CJK font candidate is found and returns a warning. A user-visible glyph failure was not executed in this round, so this remains `VALIDATION_GAP / NOT_ESTABLISHED`; do not manufacture a P2 from an environment assumption. Safe bounded check: run one Chinese fixture in a container with no configured CJK font and inspect/text-extract the resulting PDF.
- Real Word/LibreOffice/phone/print 44-line equivalence remains `VALIDATION_GAP / NOT_ESTABLISHED`. It blocks CLEAN evidence but does not prove a product defect.
- Widget PR #5 is a draft WIP outside current default. Its existence does not change current accessibility/device conclusions or authorize audit scope takeover.
- Exact-head CI zero-step failure remains a validation/admission gap. No billing, quota, YAML, or runner root cause is guessed.
- No generic undo/history, cloud storage, identity system, multi-user collaboration, or broad renderer framework is justified by this round.

## Fixed A01–J05 Round-2 matrix

Evidence codes: `SC` = source-confirmed; `SI` = static inference; `NRV` = needs runtime verification; `CV` = cannot verify executed outcome. A source property marked pass is not a runtime pass.

| Persona | Goal / prerequisite | Round-2 steps | Expected | Current observation | Evidence / grading | Finding |
|---|---|---|---|---|---|---|
| A01 | first-time mobile, ChatGPT-first | follow documented tunnel path, create, edit, export | safe first success and downloadable file | tunnel can remain unauthenticated if token omitted; export is host-local | SC P1/P2 | #1, #4 |
| A02 | Docs-familiar, no CLI | remote create/read/format/export | finish without host filesystem | structured flow exists; artifact retrieval still absent | SC P2 | #4 |
| A03 | CS student, CLI-capable | stdio create → preview → edit → layout | deterministic local loop | tools/source support path; current CI did not execute | SC + NRV | — |
| A04 | time-pressured examinee | fill exactly 44 lines, compress overflow, export | quick exact fit and final artifact | 44/45-line tests defined; remote handoff remains broken | SC + NRV / P2 handoff | #4 |
| A05 | visual learner | read pageUsage/compressionHints after edits | visible line state | structured layout report exists; real client rendering unverified | SC + NRV | — |
| B01 | non-programmer office user | README local start then optional tunnel | shortest safe path | local path is clear; tunnel safety depends on manually setting token | SC P1 | #1 |
| B02 | junior engineer | install, check, test, recover | executable verification | npm scripts/tests exist; exact-head jobs have zero steps | NRV/CV | — |
| B03 | reversible formatting user | two same-version edits in overlap | one commit, one conflict | per-answer lock + commit-time version check now coded; execution receipt absent | SC fix + CV | #3 |
| B04 | research assistant | structured answer → DOCX/PDF/TXT | traceable retrievable artifact | local file created by source path; remote bytes unavailable | SC P2 | #4 |
| B05 | mobile/shift user | continue away from server host | owner-only remote use and file retrieval | both auth enforcement and artifact handoff remain incomplete | SC P1/P2 | #1, #4 |
| C01 | police/public-sector accuracy | concurrent revision of one answer | accepted change cannot silently disappear | root cause source-fixed in process; no executed receipt | SC fix + CV | #3 |
| C02 | teacher, low learning cost | list/reopen multiple answers | predictable saved-state workflow | list/read/persistent JSON paths present | SC + NRV | — |
| C03 | security-sensitive | expose connector through HTTPS tunnel | owner auth before any answer tool | loopback+tunnel no-token path remains reachable | SC P1 | #1 |
| C04 | long-flow creator | repeated preview/write with occasional overlap | version conflict instead of overwrite | source now serializes same answer; exact execution missing | SC fix + CV | #3 |
| C05 | SRE | inspect startup/auth/body-limit/timeout | fail closed and observable receipts | non-loopback fails closed, loopback+tunnel does not; CI zero-step | SC P1 + NRV | #1 |
| D01 | manager | list answers/check layout summaries | concise status | structured outputs exist; no new defect found | SC | — |
| D02 | PM | inspect version across overlapping edits | monotonic authoritative version | commit-time expectedVersion check now coded | SC fix + CV | #3 |
| D03 | IT admin | configure reverse tunnel | explicit security boundary | auth is optional on the documented default-loopback tunnel route | SC P1 | #1 |
| D04 | cost-sensitive operator | run core flow locally | no paid provider dependency | core repo has no required paid model/service | SC | — |
| D05 | compliance/audit | remote list/read/mutate/export | authorization and traceable output | tunnel owner boundary incomplete; artifact remains host-local | SC P1/P2 | #1, #4 |
| E01 | traditional office user | local create and DOCX export | usable office handoff | DOCX exporter exists; real Word receipt absent | SC + NRV | — |
| E02 | larger-text desktop user | open/zoom DOCX/PDF | stable readable layout | no Word/LibreOffice/zoom execution evidence | NRV | — |
| E03 | low digital familiarity | stale/repeated edit | clear conflict, no silent overwrite | source error contract and lock improved; no runtime receipt | SC fix + CV | #3 |
| E04 | cloud-unfamiliar | stdio or loopback only | remain local | stdio/loopback supported and no remote dependency required | SC | — |
| E05 | long reading session | review two-page grid | stable output | deterministic grid modeled; real viewer fatigue/readability not verified | NRV | — |
| F01 | senior first-time user | remote ChatGPT create/export | file arrives in client | export path points to server host | SC P2 | #4 |
| F02 | low vision | zoom final artifact | perceivable content | renderer/screen-reader/zoom receipts absent | NRV | — |
| F03 | low motor precision | use external MCP client controls | no repo-owned fine-pointer blocker | product exposes tools, not direct current GUI; client UX unverified | NRV | — |
| F04 | memory-load sensitive | stop/reopen saved answer | current state recoverable | persistent answer JSON and list/read exist | SC + NRV restart | — |
| F05 | assisted setup then self-use | helper configures server; user later remote | safe repeatable access | manual token requirement can be omitted; file handoff incomplete | SC P1/P2 | #1, #4 |
| G01 | keyboard-only | operate through MCP client | keyboard-completable path | repo tools are non-pointer API; external client behavior unverified | NRV | — |
| G02 | screen reader | consume structured answer and export | meaningful output order | structured text exists; PDF/DOCX AT receipts absent | NRV | — |
| G03 | color-vision limitation | interpret state/errors | text/non-color status | tool outputs/errors are textual/structured | SC + NRV client | — |
| G04 | 200% zoom/narrow screen | remote export then view | task survives narrow device | remote retrieval blocks the handoff before viewer validation | SC P2 + NRV | #4 |
| G05 | slow/high-latency network | delayed/retried mutation and export | deterministic conflict/recovery | same-answer serialization is coded; response-loss/failure-injection not executed | SC fix + NRV | #3 adjacent |
| H01 | Windows developer | generate Chinese DOCX/PDF | readable output | Windows CJK font candidates exist; real viewer receipt absent | SI + NRV | — |
| H02 | macOS developer | export Chinese PDF without custom font | readable glyphs | no macOS-specific font candidate; actual fallback failure unexecuted | NOT_ESTABLISHED + NRV | deferred |
| H03 | Linux/CI non-interactive | npm check/test/build | repeatable headless verification | scripts and tests exist; current Actions jobs executed zero steps | NRV/CV | — |
| H04 | self-host/tunnel operator | publish MCP and retrieve exports | auth + bounded artifact channel | #1 and #4 both remain on default | SC P1/P2 | #1, #4 |
| H05 | first-time maintainer | read docs/source/tests | clear contract and bounded fix scope | docs/source tests are coherent; runtime evidence remains incomplete | SC + NRV | — |
| I01 | resend/duplicate click | two overlapping expectedVersion=N writes | exactly one commits | source/test fixture now enforce this; no executed receipt | SC fix + CV | #3 |
| I02 | restart then resume | reopen saved answer | persisted state returns | file persistence exists; crash/restart not executed | SI + NRV | — |
| I03 | malformed input/id | send invalid IDs/oversized fields | reject without corruption | zod/safeId/size guards exist | SC + NRV fuzz | — |
| I04 | timeout/5xx | lose response around mutation | authoritative state can be re-read safely | re-read/versioning exists; injected timeout/retry path not executed | SI + NRV | #3 adjacent |
| I05 | partial success then retry | export succeeds on server but response/client path breaks | recover exact artifact | local path may exist, but remote client cannot retrieve through current contract | SC P2 | #4 |
| J01 | large input | many sections/long text | bounded cost and deterministic rejection | schemas/body limit cap several inputs; no scale benchmark | SC bounds + NRV perf | — |
| J02 | parallel operation | same-answer vs different-answer writes | same answer serialized, different answers independent | per-answer map implements intended granularity; execution missing | SC fix + CV | #3 |
| J03 | long-running use | repeated saves/exports | no corruption/resource leak | atomic file replace present; soak/retention evidence absent | NRV | — |
| J04 | privacy/security-sensitive | remote tunnel list/read/mutate | owner-only | no-token loopback+tunnel remains possible | SC P1 | #1 |
| J05 | expert automation | preview/edit/check/export with concurrency | composable, safe, remotely complete | local structured API is strong; remote auth/artifact gaps remain, #3 runtime proof absent | SC P1/P2 + CV | #1, #3, #4 |

## Ten required dimensions — Round-2 result

1. **First understanding / first success** — README and structured tools remain clear; remote first-success is still interrupted by #4 and can cross the unsafe tunnel boundary in #1.
2. **Core task** — source/test definitions cover create/read/preview/edit/layout/export and exact 44-line capacity. Exact current-head execution is unavailable.
3. **Error recovery** — explicit errors and expectedVersion are improved; same-process atomicity has a source fix, but current runtime verification is still missing.
4. **Data safety** — local file writes use atomic replacement and per-answer serialization. Remote owner authorization remains P1 #1.
5. **Observability** — health/readiness, structured errors and current test definitions exist; exact Actions jobs recorded zero steps, so executed observability is incomplete.
6. **Accessibility / device** — API/text structure is favorable, but real keyboard, screen-reader, 200% zoom, phone, Word/PDF viewer and print receipts remain missing; #4 blocks remote/mobile artifact completion.
7. **Performance / cost** — request/body/schema bounds exist and core has no paid provider requirement; no meaningful load/soak benchmark is claimed.
8. **Maintainability** — code is compact, typed, test-oriented, and fixes #3 locally rather than adding infrastructure. Open PR #6 stays narrow around #4; no broad platform work is required.
9. **Failure injection** — body-limit paths are defined in integration tests; timeout/response loss/429/5xx, process interruption, renderer absence and remote tunnel negative paths lack executed current receipts.
10. **Trust** — structured previews/version/layout aid trust, but #1 means remote ownership is not fail-closed and #4 means final remote artifact delivery is incomplete. These prevent CLEAN regardless of report completeness.

## Runtime evidence boundary / next safe checks

This round intentionally did not claim runtime execution from source or a red CI badge. Needed bounded checks are:

1. On `92b10e3...` or a later product SHA, run `npm run check` + `npm test` in a clean isolated checkout and preserve command/exit-code receipts; specifically confirm the concurrent expectedVersion test.
2. Use temporary answer/export directories and a local-only proxy/tunnel simulation: show that a remote-mode configuration without valid owner auth fails before any MCP tool execution. Do not expose production data or a public unauthenticated endpoint.
3. After #4 lands, use an isolated MCP client to export DOCX/PDF/TXT and fetch the exact returned artifact; verify invalid/missing handles fail closed and cannot read arbitrary files.
4. Render the same fixed 44-line fixture in Word, LibreOffice, a PDF viewer, phone/narrow viewport and print/PDF path; record page count/wrapping/line-grid differences instead of assuming equivalence.
5. In an environment without a configured CJK font, run one Chinese PDF fixture and inspect glyph/text result before promoting the font fallback candidate to a defect.

## Coordination / dedupe

- No new Issue was created: every current P0/P1/P2-quality finding maps to existing #1/#3/#4.
- No existing Issue was updated because this round produced no materially new current-default evidence beyond the already-recorded post-fix states.
- #6 is active candidate work for #4 and was not modified; #5 is an independent draft widget WIP and was not pulled into this audit scope.
- No PR, branch, source, CI/config, secret, permission, setting, deployment, worker, GOAL or paid/external service was modified.
- No `not_planned` disposition was invented and no issue was closed merely to improve CLEAN accounting.

## CLEAN accounting

Round 2 is a **complete fixed A01–J05 50/50 review**, but it is **not a qualifying CLEAN round**.

- New independent actionable P0/P1/P2: **0**.
- New confirmed current-default REGRESSION: **0**.
- Existing current actionable state: #1 P1 STILL_REPRODUCIBLE; #4 P2 STILL_REPRODUCIBLE; #3 source correction present but `CANNOT_VERIFY` executed regression.
- Required real runtime/renderer/device evidence: incomplete.
- Consecutive qualifying CLEAN rounds: **0/2**.
- Repository status: **NOT CLEAN**.

The complete review does not lower severity to create a pass, does not count candidate PRs as fixes, and does not treat audit-only commits as product changes.
