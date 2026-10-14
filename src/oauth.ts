import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";

export const OAUTH_SCOPES = ["essay.read", "essay.write", "essay.export"] as const;
export const WRITE_TOOLS = ["create_answer", "write_answer", "replace_text", "format_section", "insert_text", "delete_text"] as const;
export const EXPORT_TOOLS = ["export_docx", "export_pdf", "export_text"] as const;
export const READ_TOOLS = ["list_templates", "load_exam_paper", "list_answers", "read_answer", "preview_write_answer",
  "preview_replace_text", "preview_format_section", "preview_insert_text", "preview_delete_text",
  "reflow_answer", "check_layout", "render_answer_sheet"] as const;
export function toolScope(name: string): string {
  return (READ_TOOLS as readonly string[]).includes(name) ? "essay.read"
    : (EXPORT_TOOLS as readonly string[]).includes(name) ? "essay.export" : "essay.write";
}
export type OAuthPrincipal = { issuer: string; sub: string; ownerKey: string; scopes: string[] };
export function principalOwnerKey(issuer: string, sub: string): string {
  return createHash("sha256").update(JSON.stringify([issuer, sub])).digest("hex");
}
export class OAuthError extends Error {
  constructor(readonly status: 401 | 403 = 401, readonly scope = "essay.read") {
    super(status === 403 ? "insufficient_scope" : "Unauthorized");
  }
}
export function requireScope(principal: Pick<OAuthPrincipal, "scopes">, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new OAuthError(403, scope);
}
function trustedUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== "https:"
    && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Invalid OAuth URL configuration.");
  return value;
}
export function oauthConfiguration(env = process.env) {
  const mode = env.AUTH_MODE ?? "bearer";
  if (!["bearer", "oauth", "both"].includes(mode)) throw new Error("AUTH_MODE must be bearer, oauth or both.");
  if (mode === "bearer") return { mode } as const;
  const resource = trustedUrl(env.OAUTH_RESOURCE_URL ?? "");
  const issuers = (env.OAUTH_ISSUERS ?? "").split(",").map(s => s.trim()).filter(Boolean).map(trustedUrl);
  if (!issuers.length) throw new Error("OAuth requires an issuer allowlist.");
  // One pinned JWKS URI must be authoritative for every allowed issuer.
  const jwksUri = trustedUrl(env.OAUTH_JWKS_URI ?? "");
  const refreshBackoffMs = Number(env.OAUTH_JWKS_BACKOFF_SECONDS ?? "30") * 1000;
  if (!Number.isFinite(refreshBackoffMs) || refreshBackoffMs <= 0 || refreshBackoffMs > 300_000) throw new Error("OAUTH_JWKS_BACKOFF_SECONDS must be between 1 and 300.");
  return { mode: mode as "oauth" | "both", resource, issuers, jwksUri, refreshBackoffMs,
    requireAtJwt: strictBoolean(env.OAUTH_REQUIRE_AT_JWT, "OAUTH_REQUIRE_AT_JWT") };
}
function strictBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be "true" or "false".`);
}
export function protectedResourceMetadata(config: { resource: string; issuers: string[] }) {
  return { resource: config.resource, authorization_servers: config.issuers,
    scopes_supported: [...OAUTH_SCOPES], bearer_methods_supported: ["header"] };
}
export function oauthChallenge(resource: string, error?: OAuthError, invalidToken = false): string {
  const metadata = new URL("/.well-known/oauth-protected-resource", resource).href;
  return 'Bearer resource_metadata="' + metadata + '", scope="' + (error?.scope ?? "essay.read")
    + '"' + (error?.status === 403 ? ', error="insufficient_scope"' : invalidToken ? ', error="invalid_token"' : '');
}
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string; key_ops?: string[] };
export function createOAuthVerifier(config: { issuers: string[]; resource: string; jwksUri: string; refreshBackoffMs?: number; requireAtJwt?: boolean }, options: {
  now?: () => number; ttlMs?: number; timeoutMs?: number; fetch?: typeof fetch;
} = {}) {
  const now = options.now ?? Date.now;
  const fetchKeys = options.fetch ?? fetch;
  let keys: Jwk[] = [], until = 0, pending: Promise<void> | undefined;
  const backoffMs = config.refreshBackoffMs ?? 30_000;
  if (!Number.isFinite(backoffMs) || backoffMs <= 0) throw new Error("Invalid JWKS backoff.");
  let refreshAfter = 0;
  const refresh = async (unknownKid = false) => {
    if (pending) return pending;
    if (now() < refreshAfter) throw new OAuthError();
    // ponytail: global unknown-kid cooldown; per-kid state only if rotation latency matters.
    if (unknownKid) refreshAfter = now() + backoffMs;
    pending = (async () => {
      const response = await fetchKeys(config.jwksUri, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
      if (!response.ok) throw new OAuthError();
      if (!response.body) throw new OAuthError();
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 256 * 1024) { await reader.cancel(); throw new OAuthError(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const jwks: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const list = (jwks as { keys?: unknown })?.keys;
      if (!Array.isArray(list) || !list.length || list.length > 100
        || list.some(k => !k || typeof k !== "object" || typeof k.kid !== "string")) throw new OAuthError();
      keys = list;
      until = now() + (options.ttlMs ?? 300_000);
    })().catch(error => {
      refreshAfter = now() + backoffMs;
      throw error;
    }).finally(() => { pending = undefined; });
    await pending;
  };
  return async (token: string): Promise<OAuthPrincipal> => {
    try {
      if (token.length > 16_384) throw new OAuthError();
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new OAuthError();
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (!["RS256", "ES256"].includes(header.alg) || typeof header.kid !== "string"
        || (config.requireAtJwt && !(typeof header.typ === "string" && ["at+jwt", "application/at+jwt"].includes(header.typ.toLowerCase())))
        || !header.kid || header.crit !== undefined || header.b64 !== undefined) throw new OAuthError();
      const seconds = now() / 1000, skew = 30;
      const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (!config.issuers.includes(claims.iss) || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 1024
        || !Array.isArray(audience) || !audience.every((a: unknown) => typeof a === "string" && a.length > 0) || !audience.includes(config.resource)
        || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || seconds - skew >= claims.exp
        || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || seconds + skew < claims.nbf))) throw new OAuthError();
      const findKey = () => keys.filter(k => k.kid === header.kid && (!k.alg || k.alg === header.alg)
        && (!k.use || k.use === "sig") && (!k.key_ops || k.key_ops.includes("verify"))
        && (header.alg === "RS256" ? k.kty === "RSA" : k.kty === "EC" && k.crv === "P-256"));
      const stale = now() >= until;
      if (stale) await refresh();
      if (!keys.some(k => k.kid === header.kid) && !stale) await refresh(true);
      const candidates = findKey();
      if (candidates.length !== 1) throw new OAuthError();
      const key = createPublicKey({ key: candidates[0], format: "jwk" });
      if (header.alg === "RS256" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new OAuthError();
      const signature = Buffer.from(parts[2], "base64url");
      if (header.alg === "ES256" && signature.length !== 64) throw new OAuthError();
      if (!verify("sha256", Buffer.from(parts[0] + "." + parts[1]),
        header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, signature)) throw new OAuthError();
      const scopeClaims: unknown[] = typeof claims.scope === "string" ? claims.scope.split(/\s+/)
        : Array.isArray(claims.scp) ? claims.scp : [];
      const scopes = scopeClaims.filter((s): s is string => typeof s === "string" && OAUTH_SCOPES.includes(s as typeof OAUTH_SCOPES[number]));
      if (!scopes.length) throw new OAuthError(403);
      return { issuer: claims.iss, sub: claims.sub, ownerKey: principalOwnerKey(claims.iss, claims.sub), scopes };
    } catch (error) { throw error instanceof OAuthError ? error : new OAuthError(); }
  };
}
