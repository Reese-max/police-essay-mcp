/** Only explicitly transient transport/storage failures are safe to retry. */
export function isRetryableExportError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: unknown };
    if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "EBUSY", "EMFILE", "ENFILE", "EPIPE"].includes(String(value.code))) return true;
    const status = [value.status, value.statusCode, value.response?.status, value.code]
      .map(status => status == null ? NaN : Number(status)).find(Number.isFinite);
    if ([408, 429, 500, 502, 503, 504].includes(status ?? 0)) return true;
    error = value.cause;
  }
  return false;
}

export function publicExportMessage(message: string): string {
  return message.replace(/\r?\n\s*at\s[^\n]*/g, "")
    .replace(/(["'])(?:file:\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*?\1/g, (_match, quote: string) => quote + "<path>" + quote)
    .replace(/file:\/\/[^\s"'<>]+|\b[A-Za-z]:[\\/][^\s"'<>]+|(^|[\s("'=:：])\/(?!\/)[^\s"'<>]+/g,
      (_match, prefix: string | undefined) => (prefix ?? "") + "<path>");
}
