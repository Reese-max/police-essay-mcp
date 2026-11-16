// Parsing helpers for 全國法規資料庫 law pages, kept apart from the fetching script so they can be tested offline.
export const unescape = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
// Whitespace in these pages is layout (&nbsp; padding around article numbers), not wording, so it is dropped.
export const strip = (s: string) => unescape(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, "");

// Match whole attributes and class tokens: `data-id="VaildState"` or `law-vaildMemo-header` are other elements.
const STATE_ROW = /<tr(?=[^>]*\sid="VaildState")[^>]*>([\s\S]*?)<\/tr>/i;
const MEMO = /<div(?=[^>]*\sclass="(?:[^"]*\s)?law-vaildMemo(?:\s[^"]*)?")[^>]*>([\s\S]*?)<\/div>/i;
const BANNER = "本法規部分或全部條文尚未生效";

// 生效狀態: the page shows amended text before the Executive Yuan sets its effective date; keep that warning in full.
export function parseEffectiveNote(html: string): string | undefined {
  const fail = () => { throw new Error("page layout changed (生效狀態 text not parsed)"); };
  const row = STATE_ROW.exec(html)?.[1];
  // The banner sentence without a readable row means the layout changed; never drop the warning silently.
  if (row === undefined) return html.includes(BANNER) || /\sid="VaildState"/i.test(html) ? fail() : undefined;
  // The summary ends at the 連結舊法規內容 button (id hyLawCon), not at any link inside the sentence.
  const summary = strip(/<p\b[^>]*>([\s\S]*?)(?:<a\b[^>]*\bid="hyLawCon"|<\/p>)/i.exec(row)?.[1] ?? "");
  const memoHtml = MEMO.exec(row)?.[1];
  const memo = memoHtml?.split(/<br\b[^>]*>/i).map(strip).filter(Boolean) ?? [];
  if (!summary || (/law-vaildMemo/.test(row) && !memo.length)) return fail();
  return [summary, ...memo].join("\n");
}
