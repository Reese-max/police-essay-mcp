import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { createGuard, decide, revokePublicAccess, withoutPublicAccess, type IamPolicy } from "../infra/budget-guard/guard.mjs";

const BUDGET = "budget-123";
const SERVICE = "projects/p/locations/us-central1/services/police-essay";
// A Pub/Sub push body as Cloud Billing sends it for a budget notification.
const push = (data: unknown, budgetId = BUDGET) => ({
  message: { attributes: { budgetId, billingAccountId: "0161D3", schemaVersion: "1.0" }, data: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)).toString("base64") },
  subscription: "projects/p/subscriptions/s",
});
// The current budget period, so the tests do not depend on the month they run in.
const now = new Date();
const PERIOD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 7)).toISOString();
const spend = (costAmount: number, budgetAmount = 30, costIntervalStart = PERIOD) => ({ budgetDisplayName: "net", costAmount, budgetAmount, budgetAmountType: "SPECIFIED_AMOUNT", currencyCode: "TWD", costIntervalStart });

test("only the configured budget's real spend at or above its amount asks for a revoke", () => {
  assert.equal(decide(push(spend(29.99)), BUDGET).action, "none");
  assert.equal(decide(push(spend(30)), BUDGET).action, "revoke");
  assert.deepEqual(decide(push(spend(45.5)), BUDGET), { action: "revoke", cost: 45.5, budget: 30, currency: "TWD", interval: PERIOD });
  assert.equal(decide(push(spend(99), "another-budget"), BUDGET).action, "ignore");
  assert.equal(decide(push(spend(99)), undefined).action, "ignore");
  assert.equal(decide(push("not json"), BUDGET).action, "ignore");
  assert.equal(decide(push({ costAmount: 5 }), BUDGET).action, "ignore");
  assert.equal(decide(push(spend(5, 0)), BUDGET).action, "ignore");
  assert.equal(decide({}, BUDGET).action, "ignore");
  // Amounts are numbers or numeric strings; anything looser is not an amount.
  assert.equal(decide(push({ ...spend(0), costAmount: "31.5" }), BUDGET).action, "revoke");
  assert.equal(decide(push({ ...spend(0), costAmount: true }), BUDGET).action, "ignore");
  assert.equal(decide(push({ ...spend(0), costAmount: "" }), BUDGET).action, "ignore");
});

test("a late notification for an earlier budget period does not revoke again", () => {
  const october = spend(45, 30, "2026-10-01T07:00:00Z");
  assert.equal(decide(push(october), BUDGET, Date.parse("2026-10-31T23:00:00Z")).action, "revoke");
  assert.equal(decide(push(october), BUDGET, Date.parse("2026-11-01T07:00:00Z")).action, "ignore");
  assert.equal(decide(push(october), BUDGET, Date.parse("2026-11-20T00:00:00Z")).reason, "notification for an earlier budget period");
  // Without a period the amounts still decide.
  assert.equal(decide(push({ ...october, costIntervalStart: undefined }), BUDGET, Date.parse("2027-01-01T00:00:00Z")).action, "revoke");
});

test("revoking removes only public invokers and keeps everything else", () => {
  const policy: IamPolicy = { version: 1, etag: "BwY=", bindings: [
    { role: "roles/run.invoker", members: ["allUsers", "serviceAccount:push@p.iam.gserviceaccount.com"] },
    { role: "roles/run.invoker", members: ["allAuthenticatedUsers"] },
    { role: "roles/run.admin", members: ["serviceAccount:guard@p.iam.gserviceaccount.com", "allUsers"] },
  ] };
  assert.deepEqual(withoutPublicAccess(policy), { version: 1, etag: "BwY=", bindings: [
    { role: "roles/run.invoker", members: ["serviceAccount:push@p.iam.gserviceaccount.com"] },
    { role: "roles/run.admin", members: ["serviceAccount:guard@p.iam.gserviceaccount.com", "allUsers"] },
  ] });
  assert.equal(withoutPublicAccess({ etag: "x", bindings: [{ role: "roles/run.invoker", members: ["user:a@b.c"] }] }), null);
  // Conditional bindings keep their condition.
  const condition = { title: "office hours", expression: "request.time.getHours('Asia/Taipei') < 18" };
  assert.deepEqual(withoutPublicAccess({ version: 3, bindings: [{ role: "roles/run.invoker", members: ["allUsers", "user:a@b.c"], condition }] }),
    { version: 3, bindings: [{ role: "roles/run.invoker", members: ["user:a@b.c"], condition }] });
  assert.equal(withoutPublicAccess({}), null);
});

test("revokePublicAccess reads and writes the service policy with the instance token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let policy: IamPolicy = { etag: "e1", bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] };
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("metadata.google.internal")) return new Response(JSON.stringify({ access_token: "tok" }));
    if (url.endsWith(SERVICE)) return new Response(JSON.stringify({ name: SERVICE, invokerIamDisabled: false }));
    if (url.includes(":getIamPolicy")) return new Response(JSON.stringify(policy));
    if (url.endsWith(":setIamPolicy")) { policy = JSON.parse(String(init?.body)).policy; return new Response("{}"); }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  assert.equal(await revokePublicAccess(SERVICE, fake), "revoked");
  assert.deepEqual(policy, { etag: "e1", bindings: [] });
  assert.equal(calls[1].url, `https://run.googleapis.com/v2/${SERVICE}`);
  // Version 3 so conditional bindings come back intact and can be written back.
  assert.equal(calls[2].url, `https://run.googleapis.com/v2/${SERVICE}:getIamPolicy?options.requestedPolicyVersion=3`);
  assert.equal((calls[3].init?.headers as Record<string, string>).authorization, "Bearer tok");
  assert.equal(calls[3].init?.method, "POST");
  // A second notification finds nothing public and writes nothing.
  assert.equal(await revokePublicAccess(SERVICE, fake), "already-private");
  assert.equal(calls.filter((call) => call.url.endsWith(":setIamPolicy")).length, 1);
  const failing = (async (url: string) => url.includes("metadata") ? new Response(JSON.stringify({ access_token: "t" })) : new Response("denied", { status: 403 })) as typeof fetch;
  await assert.rejects(revokePublicAccess(SERVICE, failing), /service 403: denied/);
  const noToken = (async () => new Response("", { status: 500 })) as typeof fetch;
  await assert.rejects(revokePublicAccess(SERVICE, noToken), /metadata token 500/);
  // A service that skips the invoker check stays public without allUsers, so revoking cannot help: fail loudly.
  const open = (async (url: string) => url.includes("metadata") ? new Response(JSON.stringify({ access_token: "t" }))
    : new Response(JSON.stringify({ name: SERVICE, invokerIamDisabled: true }))) as typeof fetch;
  await assert.rejects(revokePublicAccess(SERVICE, open), /invoker IAM check is disabled/);
});

test("the push endpoint acknowledges notifications and asks for a retry only when revoking fails", async () => {
  const revoked: string[] = [];
  let fail = false;
  const logs: Array<Record<string, unknown>> = [];
  const server = createServer(createGuard({ service: SERVICE, budgetId: BUDGET, log: (entry) => logs.push(entry),
    revoke: async (service) => { if (fail) throw new Error("boom"); revoked.push(service); return "revoked"; } }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    assert.equal((await post(push(spend(10)))).status, 204);
    assert.equal((await post(push(spend(99), "another-budget"))).status, 204);
    assert.equal((await post("{not json")).status, 204);
    assert.deepEqual(revoked, []);
    assert.equal((await post(push(spend(31)))).status, 204);
    assert.deepEqual(revoked, [SERVICE]);
    fail = true;
    assert.equal((await post(push(spend(31)))).status, 500);
    assert.equal(logs.at(-1)?.severity, "ERROR");
    // Once revoking works again, the retried notification revokes.
    fail = false;
    assert.equal((await post(push(spend(31)))).status, 204);
    assert.deepEqual(revoked, [SERVICE, SERVICE]);
    assert.equal((await fetch(url)).status, 405);
    // An oversized body is not a budget notification: acknowledge it so Pub/Sub does not resend it.
    assert.equal((await post("x".repeat(70 * 1024))).status, 204);
    assert.equal(logs.at(-1)?.message, "oversized push body");
    // A sender that drops the connection mid-body does not take the server down.
    const socket = net.connect(address.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(["POST / HTTP/1.1", "Host: 127.0.0.1", "Content-Type: application/json", "Content-Length: 1000", "", '{"message":'].join("\r\n"));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await post(push(spend(1)))).status, 204);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
