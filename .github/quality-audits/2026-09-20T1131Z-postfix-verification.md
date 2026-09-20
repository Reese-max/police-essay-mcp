# Fixed 50-Persona priority post-fix verification — police-essay-mcp

Run: `2026-09-20T11:31:00Z-persona-audit-11-police-essay-mcp-postfix`

Status: **TARGETED POST-FIX VERIFICATION / NOT CLEAN / 0/2**

This is a priority verification lane for fixes that landed after Fixed-50 Round 1. It is **not** a new complete A01–J05 round and does not increment the CLEAN streak.

## Governing evidence

- Fixed A01–J05 protocol blob: `6e3499d6ef5be7e123050e1526946f6a40f99263`.
- Issue Quality v2 blob: `8167e10798071d2276addaff6b201c6b0e904a2a`.
- Product-board direction retained: local-first Taiwanese civil-service essay workflow; secure remote use before connector expansion; verify 44-line renderer/export behavior and first-success journey; do not expand into OCR, grading, LMS, cloud sync, multi-user collaboration, marketplace, or general IAM.
- Previous Fixed-50 Round 1 report commit: `0c02e515530f46f32f3878c5547a1877301a47cb`; prior product baseline: `9dbe0c7d604f1f8025aae591ead2b870fe200dab`.
- Current inspected default `main`: `92b10e3a20d21a0803176fdb67e551646fdd3696`.
- Fresh connected-owner inventory pagination exposed **38 Reese-max-owned repositories** in this run. Historical checkpoints exposed 42; keep the visibility/access gap and do not infer deletion, exclusion, or CLEAN.

## Why this lane pre-empted the fair cursor

`police-essay-mcp` had an open P1 remote/tunnel security root (#1), and real product changes landed on default after Round 1. The prior audit commit → current HEAD comparison is four commits ahead and changes HTTP security/config, storage concurrency, exporters/server behavior, tests, CI, and documentation. Priority post-fix verification therefore takes precedence over the fair cursor (`prompt-autoresearch`).

Open PR search returned none; branch discovery returned only `main`. Relevant Issue comments were fully read before mutation; all historical leases were released. No active implementation ownership was found for #1/#3 in the visible GitHub state.

## #1 P1 security — PARTIALLY_FIXED / STILL_REPRODUCIBLE

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/1

Classification remains:

- kind: `BUG`
- severity: `P1`
- evidence: `SOURCE_CONFIRMED`
- triage: `NEEDS_REVIEW`
- runtime: `NEEDS_RUNTIME_VERIFICATION`
- auto_implementation: `false`

Source improvements on current default are material: configured `MCP_AUTH_TOKEN` is checked before MCP transport handling; explicitly non-loopback `HOST` requires auth unless anonymous remote is explicitly allowed; CORS is configurable; request-size/timeout guards and `/readyz` were added.

The original supported tunnel fingerprint is not fully closed. Runtime config decides mandatory auth from the server `HOST`. With the documented/default `127.0.0.1` listener, no token is required, and `tokenMatches()` accepts requests when no token is configured. README still supports exposing that loopback `/mcp` through an HTTPS tunnel and tells the user to set a token, but the product does not enforce that requirement for the tunnel path. A tunnel can therefore proxy the loopback listener while preserving the original unauthenticated capability unless the user manually configures auth.

The new `tests/mcp-http.test.ts` starts the loopback server with `MCP_AUTH_TOKEN=integration-test-token`; it validates missing/wrong-token rejection for the configured-token path but does not test the original `loopback + tunnel exposure + no token` acceptance condition.

Minimal remaining correction: make remote/tunnel exposure an explicit fail-closed mode/profile that requires owner authentication, or otherwise enforce auth for the documented tunnel workflow. Do not build general IAM.

No production tunnel exploit, unauthorized access, or user incident was observed. Therefore this remains source-confirmed P1, not an executed exploit claim.

## #3 concurrent expectedVersion — source fix present; runtime receipt missing

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/3

Outcome: **PARTIALLY_FIXED / NEEDS_RUNTIME_VERIFICATION**.

Current `FileStore` now has a per-`answerId` write queue, re-reads current state inside the lock, validates `expectedVersion` at commit time, and uses UUID-suffixed temporary files. The current `tests/layout.test.ts` also defines the original same-process race fixture with two concurrent `expectedVersion=1` writes and asserts exactly one success, one rejection, and final version 2. This closes the original supported single-process race at source/test-definition level without database/distributed-lock expansion.

Do not close solely from source: the exact current-SHA CI did not produce an executed test receipt. Keep the tracker open until a bounded local/CI run demonstrates the concurrency fixture passing on current/recent code.

## #4 remote export retrieval — STILL_REPRODUCIBLE

Tracker: https://github.com/Reese-max/police-essay-mcp/issues/4

Current export tools still write to server-local paths and return `path/pages/layout` data. Current HTTP surface remains `/health`, `/readyz`, `/`, and `/mcp`; no bounded artifact download route/resource/handle is present, and code search found no artifact/resource URI contract. The supported remote ChatGPT flow therefore still has the same manual handoff break after export.

Classification remains `BUG / P2 / SOURCE_CONFIRMED / NEEDS_REVIEW / auto_implementation=false`. No duplicate Issue is created.

## Runtime / CI boundary

Exact current SHA has push workflow run `35507096168`, conclusion `failure`. Its Node 20 and Node 22 jobs both expose zero recorded steps. This proves neither product-test failure nor successful test execution. Treat it as a current validation/admission gap of unknown cause; do not guess billing, runner quota, YAML, or provider causes.

No live tunnel, ChatGPT connector, Office/LibreOffice, browser/mobile, assistive technology, production data, timeout/429/5xx injection, merge, deploy, or paid-provider action was performed.

## Delta and CLEAN accounting

- New independent actionable P0/P1/P2 finding: **0**.
- Confirmed new regression: **0**.
- Landed relevant fixes re-verified: **#1 and #3**.
- #1: **PARTIALLY_FIXED / STILL_REPRODUCIBLE**.
- #3: **PARTIALLY_FIXED / source correction present; runtime receipt missing**.
- #4: **STILL_REPRODUCIBLE**.
- New/reopened Issue: **0**.
- Qualifying full fixed-50 rounds added: **0**.
- CLEAN streak: **0/2**.
- Repository: **NOT CLEAN**.

Reasons: P1 #1 remains reachable on the documented loopback+tunnel no-token path; P2 #4 remains current; #3 lacks executed post-fix evidence; required exact-head remote/export/render/mobile/accessibility receipts remain incomplete. Portfolio CLEAN is also ineligible while repository inventory visibility remains 38-vs-historical-42.

Low-noise notification trigger: **NONE**. This run does not create an Issue merely to produce output.

The fair fixed-50 cursor remains **`Reese-max/prompt-autoresearch`** because this priority post-fix lane does not consume the fair rotation slot.
