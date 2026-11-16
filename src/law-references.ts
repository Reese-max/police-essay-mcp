import { LAW_CUTOFF, LAW_TEXTS } from "./law-references-data.js";

// Statute text is not copyrightable (著作權法第9條第1項第1款), so the public server may hand it to any client verbatim.
// A law is attached only when the question names its subject; keep triggers narrow so unrelated questions get nothing.
// Search algorithms (深度優先搜索…) and ITIL-style incident handling share words with criminal search and security incidents.
const ALGORITHM_SEARCH = /(?:優先|啟發式|狀態空間|二元|二分|線性|循序|局部|窮舉|鄰域|束|樹狀?)搜索|搜索(?:引擎|演算法|樹|空間)/g;
// 假扣押 is a civil-procedure remedy, not a criminal seizure.
const CIVIL_SEIZURE = /假扣押/g;
const SECURITY_CONTEXT = /資安|資通安全|資訊安全|惡意|勒索|入侵|駭客|端點防護|告警|外洩/;
const securityIncident = (t: string) => /資通安全事件|資安事件|資訊安全事件/.test(t) || (/資訊事件|事件通報/.test(t) && SECURITY_CONTEXT.test(t));
const TRIGGERS: Record<string, (text: string) => boolean> = {
  C0010001: t => /搜索|搜扣|扣押|刑事訴訟法/.test(t.replace(ALGORITHM_SEARCH, "").replace(CIVIL_SEIZURE, "")),
  A0030297: t => /資通安全管理法|資安法|資通安全長|資安長/.test(t) || securityIncident(t),
  A0030305: securityIncident,
  I0050021: t => /個人資料|個資/.test(t),
};

export type LawReferences = {
  source: string; cutoff: string;
  laws: { name: string; amended: string; effectiveNote?: string; articles: { article: string; text: string }[] }[];
};

const articleLabel = (no: string) => { const [main, sub] = no.split("-"); return `第${main}條${sub ? `之${sub}` : ""}`; };

export function lawReferencesFor(questions: (string | undefined)[]): LawReferences | undefined {
  // Judge each question on its own; words from two unrelated questions must not combine into a trigger.
  const texts = questions.filter((q): q is string => !!q);
  const laws = LAW_TEXTS.filter(law => texts.some(t => TRIGGERS[law.pcode]?.(t))).map(law => ({
    name: law.name, amended: law.amended, ...(law.effectiveNote ? { effectiveNote: law.effectiveNote } : {}), articles: law.articles.map(a => ({ article: articleLabel(a.no), text: a.text })),
  }));
  return laws.length ? { source: "全國法規資料庫（law.moj.gov.tw）", cutoff: LAW_CUTOFF, laws } : undefined;
}

export function lawReferenceHint(refs: LawReferences): string {
  const count = refs.laws.reduce((sum, law) => sum + law.articles.length, 0);
  return `\n已附${refs.laws.map(law => `${law.name}（${law.amended}修正）`).join("、")}相關條文原文 ${count} 條（lawReferences，${refs.source}，資料截止${refs.cutoff}）：`
    + "寫這些法規的條號或條文內容以此為準，用自己的話摘要，只引用題目用得到的；題目要求的其他法規照常作答，條號沒把握時只寫法規名稱與要件，不捏造條號。"
    + refs.laws.filter(law => law.effectiveNote).map(law =>
      `${law.name}有修正條文尚未生效（見 effectiveNote）：引用 effectiveNote 列出條號的修正內容時註明「修正條文施行日期由行政院定之」，不寫成已施行的現行規定；未列出的條文不受影響。`).join("");
}
