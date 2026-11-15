import { LAW_CUTOFF, LAW_TEXTS } from "./law-references-data.js";

// Statute text is not copyrightable (著作權法第9條第1項第1款), so the public server may hand it to any client verbatim.
// A law is attached only when the question names its subject; keep triggers narrow so unrelated questions get nothing.
const TRIGGERS: Record<string, RegExp> = {
  C0010001: /搜索(?!引擎)|扣押|刑事訴訟法/,
  A0030297: /資通安全管理法|資安法|資通安全事件|資安事件|資訊事件|事件通報|資通安全長|資安長/,
  A0030305: /資通安全事件|資安事件|資訊事件|事件通報/,
  I0050021: /個人資料|個資/,
};

export type LawReferences = {
  source: string; cutoff: string;
  laws: { name: string; amended: string; articles: { article: string; text: string }[] }[];
};

const articleLabel = (no: string) => { const [main, sub] = no.split("-"); return `第${main}條${sub ? `之${sub}` : ""}`; };

export function lawReferencesFor(questions: (string | undefined)[]): LawReferences | undefined {
  const text = questions.filter(Boolean).join("\n");
  const laws = LAW_TEXTS.filter(law => TRIGGERS[law.pcode]?.test(text)).map(law => ({
    name: law.name, amended: law.amended, articles: law.articles.map(a => ({ article: articleLabel(a.no), text: a.text })),
  }));
  return laws.length ? { source: "全國法規資料庫（law.moj.gov.tw）", cutoff: LAW_CUTOFF, laws } : undefined;
}

export function lawReferenceHint(refs: LawReferences): string {
  const count = refs.laws.reduce((sum, law) => sum + law.articles.length, 0);
  return `\n已附${refs.laws.map(law => `${law.name}（${law.amended}修正）`).join("、")}相關條文原文 ${count} 條（lawReferences，${refs.source}，資料截止${refs.cutoff}）：`
    + "寫法規名稱、條號或條文內容以此為準，用自己的話摘要，只引用題目用得到的；未附上的條號沒把握就不寫。";
}
