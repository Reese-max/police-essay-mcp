# police-essay-mcp — Fixed 50-Persona Audit Round 1

Run: `2026-09-19T23:18:27Z`  
Scope: fixed A01–J05 synthetic personas; this is not human research or 50 independent validations.

## Protocol / inspected state

- Fixed persona protocol blob: `6e3499d6ef5be7e123050e1526946f6a40f99263` (`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`).
- Issue Quality v2 blob: `8167e10798071d2276addaff6b201c6b0e904a2a`.
- Default branch at round start: `main`.
- Inspected HEAD: `801a518d34333dc42a83c605baef45e511615b28`.
- Product-facing baseline: `9dbe0c7d604f1f8025aae591ead2b870fe200dab`; `801a518...` only adds the product-board audit and is treated as audit-only evidence, not a product fix.
- Owner direction read from `.github/quality-audits/2026-09-19T2300Z-product-board-audit.md`: keep the product narrow around structured local-first essay editing, deterministic 44-line layout and DOCX/PDF/TXT export; secure remote/tunnel use before broadening it. Do not turn this into OCR, scoring, LMS, cloud sync, multi-user collaboration or generic IAM.
- Branches: only `main` was visible. All-state PR search returned none.
- Issues before this fixed-50 round: #1 only; #1 is `BUG / P1 / SOURCE_CONFIRMED / NEEDS_REVIEW` for unauthenticated remote/tunnel MCP.
- GitHub Actions: `total_count=0`; no exact-head CI/runtime receipt exists.
- Source reviewed: README, SPECIFICATION, package manifest, `src/index.ts`, `src/server.ts`, `src/domain.ts`, `src/storage.ts`, `src/layout.ts`, `src/exporters.ts`, the sole test file, current Issues/PRs/branches and product-board audit.

Commit-fixed evidence:

- README: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/README.md
- specification: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/SPECIFICATION.md
- HTTP/stdio entry: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/src/index.ts
- MCP tools: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/src/server.ts
- version contract: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/src/domain.ts
- storage: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/src/storage.ts
- layout: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/src/layout.ts
- exporters: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/src/exporters.ts
- tests: https://github.com/Reese-max/police-essay-mcp/blob/9dbe0c7d604f1f8025aae591ead2b870fe200dab/tests/layout.test.ts

The connected GitHub response exposes blob SHAs and function-level content but not stable source line indexes, so this report does not invent line numbers.

## Findings / issue mapping

### Existing F1 — remote/tunnel MCP has no owner authorization boundary

- Issue: #1 — https://github.com/Reese-max/police-essay-mcp/issues/1
- fingerprint: `police-essay-mcp + HTTP MCP + README-supported HTTPS tunnel + unauthenticated /mcp + list/read/mutate/delete/export all local answers`
- decision: `BUG / P1 / CONFIRMED / SOURCE_CONFIRMED / NEEDS_REVIEW / auto_implementation=false`
- boundary: no tunnel exploit or incident was executed/observed in this round.

### New F2 — expectedVersion is not atomic across overlapping mutations

- Issue: #3 — https://github.com/Reese-max/police-essay-mcp/issues/3
- fingerprint: `police-essay-mcp + same-answer overlapping mutations + expectedVersion checked before non-atomic save + both writers accept version N and persist N+1 + one accepted edit can be overwritten`
- decision: `BUG / P2 / CONFIRMED / SOURCE_CONFIRMED / NEEDS_REVIEW / auto_implementation=false`
- source chain: every mutation does `getAnswer → assertExpectedVersion → derive version+1 → saveAnswer`; `assertExpectedVersion` checks only the already-read object, and `saveAnswer` has no per-answer serialization/CAS. Same-process saves also share `${filename}.${process.pid}.tmp` for the same answer.
- smallest safe direction: serialize the current process’s same-answer mutation critical section and use a write-safe temporary path. Do not add a DB/distributed lock/general collaboration system without separate evidence.
- runtime needed: two concurrent version-N mutations against a temporary store; exactly one must commit and the other must return a version conflict.

### New F3 — remote export returns only a server-local filesystem path

- Issue: #4 — https://github.com/Reese-max/police-essay-mcp/issues/4
- fingerprint: `police-essay-mcp + remote ChatGPT MCP export + exporter writes host-local file + tool returns only local filesystem path + no MCP/HTTP retrievable artifact`
- decision: `BUG / P2 / CONFIRMED / SOURCE_CONFIRMED / NEEDS_REVIEW / auto_implementation=false`
- source chain: README supports the HTTPS-tunnel ChatGPT workflow; export tools return `path`, exporters write local files, HTTP only exposes `/`, `/health`, `/mcp`, and registered resources are template/workflow only. A remote MCP client therefore has no current product route to retrieve the generated bytes.
- existing workaround: the user can manually access the MCP host’s `exports` directory. This is why the issue is P2 rather than P1.
- smallest safe direction: return a bounded owner-authorized generated-artifact handle/resource after export; do not add cloud storage or a generic file service.

### Rejected / deferred candidates

- macOS PDF CJK font discovery: exporter has Windows/Linux candidates and configurable font paths but no macOS candidate. This is recorded as `LIKELY / VALIDATION_GAP / NOT_ESTABLISHED` until an isolated macOS export demonstrates the actual glyph/render failure. No issue manufactured.
- exact Word/LibreOffice/PDF viewer/phone/physical-print 44-line agreement: `VALIDATION_GAP / NOT_ESTABLISHED`; absence of renderer receipts blocks CLEAN but is not itself a product bug.
- no GitHub Actions workflow/run: `VALIDATION_GAP`; it does not become P1/P2 by itself.
- idempotency after response loss for `create_answer`/export: possible duplicate artifacts/documents were not established at P2 impact in this round; retain as a future failure-injection scenario rather than opening speculative work.
- no generic undo/history system: current versioned snapshots and local files do not prove a P2 failure for the intentionally narrow single-user v1; do not create a framework issue.

## Fixed A01–J05 matrix

Evidence codes: `SC` = source-confirmed; `SI` = static inference; `NRV` = needs runtime verification. `PASS(SC)` means only the stated source property was confirmed; it is not a runtime pass.

| Persona | Goal / prerequisite | Input / steps | Expected | Observed | Evidence / severity | Finding |
|---|---|---|---|---|---|---|
| A01 | first-time mobile user, ChatGPT-first | follow README remote setup, draft then export | understand path and obtain final file | workflow documented; generated bytes are not retrievable remotely | SC / P2 | #4 |
| A02 | Docs-familiar, no CLI | use remote MCP create/read/edit/export | no terminal file hunting | export result is host-local path only | SC / P2 | #4 |
| A03 | CS student, CLI-capable | stdio create → edit → layout | deterministic local workflow | stdio entry and structured tools exist; no exact-head execution receipt | SC + NRV | — |
| A04 | time-pressured examinee | fit answer to 44 lines, export | exact remaining/overflow guidance, rapid handoff | deterministic layout/hints exist; remote handoff still breaks at artifact retrieval | SC / P2 | #4 |
| A05 | visual learner | inspect per-page usage and compression hints | clear state after each edit | layout report/page usage/hints are structured | PASS(SC), renderer NRV | — |
| B01 | non-programmer office user | follow README install/start | shortest safe start | npm/start instructions exist; tunnel security remains unsafe before #1 | SC / P1 boundary | #1 |
| B02 | junior engineer | install, test, recover from error | testable startup/errors | scripts exist; no Actions receipt and only layout-focused tests | NRV | — |
| B03 | designer, reversible edits | format one paragraph then concurrent second edit | unrelated/newer edit must not be lost | expectedVersion contract exists but check/save is non-atomic | SC / P2 | #3 |
| B04 | research assistant | create structured answer and export DOCX/PDF/TXT | traceable artifact | answer/version is structured; remote artifact cannot be fetched | SC / P2 | #4 |
| B05 | shift/mobile user | remote edit/export away from MCP host | finish without host filesystem access | no generated-artifact route | SC / P2 | #4 |
| C01 | police/public-sector accuracy | edit same answer with version guard | accepted changes remain authoritative | concurrent accepted change can be overwritten | SC / P2 | #3 |
| C02 | teacher, low learning cost | reuse template and multiple saved answers | list/read/create safely | tools exist; multi-answer serial path is source-supported | PASS(SC), runtime NRV | — |
| C03 | high-risk/security-sensitive | expose remote connector | owner-only data access | no auth before handler | SC / P1 | #1 |
| C04 | long-flow creator | many local edits, possible overlapping calls | no lost accepted edit | same-answer read/check/write race exists | SC / P2 | #3 |
| C05 | SRE | inspect fail-closed, observability, recovery | remote auth boundary and executable receipts | remote endpoint is not fail-closed; no CI run | SC P1 + validation gap | #1 |
| D01 | manager | list answers and inspect layout summary | concise state/exception view | list/layout structured outputs exist | PASS(SC), UI NRV | — |
| D02 | PM | track document version/status | version must identify current answer | monotonic serial version exists; concurrency can duplicate N+1 and lose edit | SC / P2 | #3 |
| D03 | IT admin | publish tunnel or reverse proxy | authentication before data tools | no auth; wildcard CORS default | SC / P1 | #1 |
| D04 | cost-sensitive | run core flow without paid provider | bounded local cost | no model/provider billing path in repo core | PASS(SC) | — |
| D05 | compliance/audit | prevent unauthorized read/delete/export | explicit access boundary | remote path lacks owner authorization | SC / P1 | #1 |
| E01 | traditional office user | local setup + Word export | usable documented path | Word generation exists; actual Word renderer not verified | SI + NRV | — |
| E02 | desktop, larger text needs | open generated Word/PDF and zoom | layout/readability survives renderer | no Office/zoom receipt | NRV | — |
| E03 | low digital familiarity | make a local edit, retry safely | clear conflict/recovery | serial conflicts have error text; overlapping writers can both pass | SC / P2 | #3 |
| E04 | Excel-familiar, cloud-unfamiliar | use local-first stdio/HTTP loopback | no cloud dependency required | loopback/stdio modes exist | PASS(SC), execution NRV | — |
| E05 | long reading session | inspect 44-line document | stable readable grid | source defines fixed grid; real viewer fatigue/readability unverified | NRV | — |
| F01 | senior first-time user | ChatGPT remote create/export | clear buttons/file result | client UI is outside repo; file retrieval gap remains | SC P2 + NRV | #4 |
| F02 | low vision | zoom generated doc/client | content remains perceivable | no screen/zoom/renderer evidence | NRV | — |
| F03 | low motor precision | use ChatGPT/client controls | large targets/non-destructive actions | client UI not owned by repo; delete tool is destructive-marked | SI + NRV | — |
| F04 | memory-load sensitive | resume saved answer | persistent state, current version visible | JSON persistence/list/read exist; interruption execution unverified | PASS(SC) + NRV | — |
| F05 | assisted setup then self-use | configured local server, later remote use | safe daily access and artifact completion | remote auth and artifact gaps remain | SC P1/P2 | #1, #4 |
| G01 | keyboard-only | operate through MCP client | no repo-owned pointer-only barrier | repo has no direct GUI; external client accessibility is out-of-repo and unverified | NRV | — |
| G02 | screen reader | consume answer/export | meaningful reading order | structured text exists; DOCX/PDF screen-reader output unverified | NRV | — |
| G03 | color-vision limitation | inspect status | state not color-only | tool responses are textual/structured; external UI unverified | PASS(SC) + NRV | — |
| G04 | 200% zoom/narrow screen | mobile/client + exported docs | core task survives narrow view | client/viewer runtime absent; remote file handoff fails before viewer | SC P2 + NRV | #4 |
| G05 | slow/high-latency network | remote mutation/export under delayed/retried requests | no lost update/ambiguous completion | overlapping mutation window can lose accepted edit; no failure injection run | SC / P2 | #3 |
| H01 | Windows developer | local PDF/DOCX generation | usable CJK font/export | Windows font candidates and DOCX font family are present; real Office/PDF receipt absent | SI + NRV | — |
| H02 | macOS developer | local PDF export without custom font | readable Chinese PDF | no macOS font candidate is coded; actual failure not executed | LIKELY / NRV | deferred validation |
| H03 | Linux/CI non-interactive | npm check/test/build | reproducible automation | scripts exist, but no GitHub workflow/run | validation gap | — |
| H04 | self-host/tunnel operator | expose `/mcp` safely and retrieve exports | auth + bounded artifact route | neither owner auth nor generated-artifact retrieval exists | SC P1/P2 | #1, #4 |
| H05 | first-time maintainer | read README/spec/tests and diagnose | clear single truth + executable checks | docs are detailed; tests are layout-focused and no CI receipts | PASS(SC) + NRV | — |
| I01 | repeated click/resend | overlapping mutation with same expectedVersion | duplicate/stale writer rejected | both may pass before either save commits | SC / P2 | #3 |
| I02 | close/restart then resume | list/read saved answer | persisted state returns | JSON persistence exists; crash/restart receipt absent | SI + NRV | — |
| I03 | wrong input/file/id | malformed IDs/section references | reject without silent corruption | zod/safeId/explicit section checks exist | PASS(SC), fuzz NRV | — |
| I04 | timeout/5xx | request response delayed/lost around mutation/export | safe retry and observable result | no injected run; concurrent retry window covered by F2 source path | SC P2 + NRV | #3 |
| I05 | partial success then retry | mutation saved while response races; export saved without retrievable result | recover authoritative state/artifact | read/list can recover answer; remote artifact retrieval unavailable | SC / P2 | #4; #3 adjacent |
| J01 | large data | many sections/large text/list answers | bounded performance | schemas cap several fields, but no large-scale benchmark | NRV | — |
| J02 | parallel operation | two writes to same answer and edits to different answers | same-answer conflict, unrelated answers independent | no same-answer atomic boundary | SC / P2 | #3 |
| J03 | long-running use | repeated saves/exports | no resource exhaustion/corruption | file-based persistence; no soak/retention/quota evidence | NRV | — |
| J04 | security/privacy-sensitive | tunnel access/list/read/delete/export | owner-only access | no authorization boundary | SC / P1 | #1 |
| J05 | expert automation | shortest edit/check/export loop with concurrent tool calls | composable, safe versioning and artifact handoff | structured tools strong; #3 and #4 break automation under overlap/remote export | SC / P2 | #3, #4 |

## Ten required dimensions

1. **First understanding / first success** — README and SPEC are unusually explicit; actual ChatGPT first-run journey is not executed. Remote export completion is blocked by #4.
2. **Core task** — structure, line engine and exporters exist; exact Word/PDF/print agreement is still runtime-unverified.
3. **Error recovery** — serial expectedVersion helps; overlapping mutations violate the promised stale-write protection (#3).
4. **Data safety** — remote/tunnel route has no auth (#1). No production exposure/incident is claimed.
5. **Observability** — layout/page/version outputs are structured; no CI/deployment/remote session receipt exists.
6. **Accessibility/device** — repo owns no direct GUI; screen reader, 200% zoom, mobile and rendered document accessibility need actual client/viewer evidence. #4 is directly relevant to off-host/mobile completion.
7. **Performance/cost** — local file model has no paid provider dependency; large/soak benchmarks absent.
8. **Maintainability** — README/SPEC/source are compact; only one test file and no CI workflow. Missing CI is a validation gap, not a P1/P2 defect by itself.
9. **Failure injection** — required overlap/timeout/retry cases are not executed. #3 is source-confirmed; create/export response-loss duplication remains below issue threshold pending bounded execution.
10. **Trust** — delete is marked destructive, overflow export requires explicit opt-in, but remote auth #1 is a material trust failure.

## Runtime evidence boundary

`EXECUTED_REPRODUCTION` was not claimed for #1, #3 or #4. No live tunnel, ChatGPT connector, browser/mobile session, concurrent-mutation fixture, timeout/429/5xx injection, Word/LibreOffice render, physical print or destructive production-data operation was performed. GitHub Actions currently has zero runs for this repository.

Safe next receipts:

- #1: isolated remote HTTP auth rejection/acceptance cases on disposable answer data.
- #3: temporary FileStore + two overlapping same-version writes, with exactly one commit.
- #4: isolated remote MCP connector exports DOCX/PDF/TXT and then fetches the returned bounded artifact without host filesystem access.
- layout: same 44-line fixture through DOCX + PDF + Word/LibreOffice + print/mobile preview, recording actual pagination and line placement.

## Coordination / dedup / writes

- Existing #1 comments were read in full; its prior product-board lease was released and expired before this round.
- All-state issue search, all-state PR search, branch listing and repository audit/roadmap search found no duplicates for F2/F3 before filing.
- New coordination umbrella: #2 — https://github.com/Reese-max/police-essay-mcp/issues/2.
- New actionable issues: #3 and #4. Both default `auto_implementation=false` and are `NEEDS_REVIEW`.
- No product code, CI/config, settings, secrets, permissions, branch, merge, deploy, GOAL, worker or paid/external write was started.

## CLEAN status

**NOT CLEAN — 0/2 qualifying clean rounds.**

Reasons:

- open applicable P1 #1;
- new P2 #3 and #4 reset any potential streak;
- required remote/core renderer/accessibility/failure-injection runtime evidence is incomplete;
- no exact-head Actions/runtime receipt exists.

A full 50-persona matrix was actually re-evaluated here; nevertheless this round cannot contribute to a CLEAN streak because it contains new P1/P2-class actionable findings and missing required runtime evidence.
