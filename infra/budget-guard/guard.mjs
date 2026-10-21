// Budget guard: when a project budget reports real (net) spend at or above its amount,
// it revokes public access to one Cloud Run service. It never grants access back.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);
const MAX_BODY = 64 * 1024;

/** Reads a Pub/Sub push body and decides what to do for the configured budget. */
export function decide(push, budgetId) {
  const message = push?.message ?? {};
  if (!budgetId || message.attributes?.budgetId !== budgetId) return { action: "ignore", reason: "not the configured budget" };
  let data;
  try {
    data = JSON.parse(Buffer.from(message.data ?? "", "base64").toString("utf8"));
  } catch {
    return { action: "ignore", reason: "unreadable notification" };
  }
  const cost = Number(data?.costAmount), budget = Number(data?.budgetAmount);
  if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) return { action: "ignore", reason: "notification without amounts" };
  return { action: cost >= budget ? "revoke" : "none", cost, budget, currency: data.currencyCode ?? "", interval: data.costIntervalStart ?? "" };
}

/** The same policy without public invokers, or null when it had none. */
export function withoutPublicAccess(policy) {
  let changed = false;
  const bindings = (policy.bindings ?? []).map((binding) => {
    if (binding.role !== "roles/run.invoker") return binding;
    const members = (binding.members ?? []).filter((member) => !PUBLIC_MEMBERS.has(member));
    if (members.length !== (binding.members ?? []).length) changed = true;
    return { ...binding, members };
  }).filter((binding) => (binding.members ?? []).length > 0);
  return changed ? { ...policy, bindings } : null;
}

async function accessToken(fetchImpl) {
  const response = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`metadata token ${response.status}`);
  return (await response.json()).access_token;
}

/** Removes public invokers from the service: "revoked", or "already-private" when there were none. */
export async function revokePublicAccess(service, fetchImpl = fetch) {
  const headers = { authorization: `Bearer ${await accessToken(fetchImpl)}`, "content-type": "application/json" };
  const base = `https://run.googleapis.com/v2/${service}`;
  const current = await fetchImpl(`${base}:getIamPolicy`, { headers });
  if (!current.ok) throw new Error(`getIamPolicy ${current.status}: ${await current.text()}`);
  const next = withoutPublicAccess(await current.json());
  if (!next) return "already-private";
  // The policy keeps its etag, so a concurrent change makes this fail instead of being overwritten.
  const updated = await fetchImpl(`${base}:setIamPolicy`, { method: "POST", headers, body: JSON.stringify({ policy: next }) });
  if (!updated.ok) throw new Error(`setIamPolicy ${updated.status}: ${await updated.text()}`);
  return "revoked";
}

/** Pub/Sub push handler: acknowledges every notification, and asks for a retry only when revoking failed. */
export function createGuard({ service, budgetId, revoke = revokePublicAccess, log = (entry) => console.log(JSON.stringify(entry)) }) {
  return async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > MAX_BODY) {
        response.writeHead(413).end();
        return;
      }
    }
    let push;
    try {
      push = JSON.parse(body);
    } catch {
      log({ severity: "WARNING", message: "unparsable push body" });
      response.writeHead(204).end();
      return;
    }
    const decision = decide(push, budgetId);
    if (decision.action !== "revoke") {
      log({ severity: "INFO", message: "budget notification", ...decision });
      response.writeHead(204).end();
      return;
    }
    try {
      const result = await revoke(service);
      log({ severity: "WARNING", message: `real spend reached the budget; public access ${result}`, service, ...decision });
      response.writeHead(204).end();
    } catch (error) {
      log({ severity: "ERROR", message: "could not revoke public access; Pub/Sub will retry", service, error: String(error?.message ?? error), ...decision });
      response.writeHead(500).end();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = process.env.TARGET_SERVICE, budgetId = process.env.BUDGET_ID;
  if (!service || !budgetId) throw new Error("TARGET_SERVICE and BUDGET_ID are required.");
  createServer(createGuard({ service, budgetId })).listen(Number(process.env.PORT ?? 8080));
}
