import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { createAnswerDocument, templateSchema } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { layoutQualityNotes, scoreLayout } from "../src/layout-quality.js";

const standard = templateSchema.parse(JSON.parse(await fs.readFile("templates/police_information_essay.json", "utf8")));
const neat = { neatFormat: true, autoHangingIndent: true, compactPaper: true };
const start = (line: { format: { leftIndent: number; firstLineIndent: number; hangingIndent: number }; isFirstLineOfParagraph: boolean }) =>
  line.format.leftIndent + (line.isFirstLineOfParagraph ? line.format.firstLineIndent : line.format.hangingIndent);

// The 50招 p.9 skeleton: lead/closing first line 2 cells in, headings flush on their own line,
// body every line at the 3rd cell, numbers to its left.
const skeleton = [
  { id: "intro", text: "甲".repeat(30) },
  { id: "s1", heading: "(一)公告房屋標準價格的政府層級：", text: "乙".repeat(30) },
  { id: "s2", heading: "(二)評定的依據事項：", paragraphs: [{ text: "1.依構造評定：" }, { text: `(1)${"丙".repeat(30)}` }] },
  { id: "end", text: `綜上所述，${"丁".repeat(30)}` },
];

test("neatFormat lays out the book's neat skeleton", () => {
  const answer = createAnswerDocument({ templateId: standard.id, title: "neat", sections: skeleton });
  const report = layoutSections(standard, answer.sections, neat);
  const rows = report.lines.map(line => [line.sectionId, line.isHeading, start(line)]);
  assert.deepEqual(rows, [
    ["intro", false, 4], ["intro", false, 0],
    ["s1", true, 0], ["s1", false, 4], ["s1", false, 4],
    ["s2", true, 0], ["s2", false, 2], ["s2", false, 1], ["s2", false, 4],
    ["end", false, 4], ["end", false, 0],
  ]);
  assert.equal(scoreLayout(standard, { ...answer, layoutOptions: neat }, report).misalignedContinuations, 0);
});

test("⑴ and (1) list items hang their continuation at the same text column", () => {
  const answer = createAnswerDocument({ templateId: standard.id, title: "hanging", sections: [
    { id: "circled", text: `⑴${"甲".repeat(30)}` }, { id: "parenthesized", text: `(1)${"乙".repeat(30)}` },
  ] });
  const report = layoutSections(standard, answer.sections, neat);
  for (const id of ["circled", "parenthesized"]) {
    const lines = report.lines.filter(line => line.sectionId === id);
    assert.ok(lines.length > 1);
    assert.ok(lines.slice(1).every(line => start(line) === 4), id);
  }
  assert.equal(scoreLayout(standard, { ...answer, layoutOptions: neat }, report).misalignedContinuations, 0);
});

test("neatFormat leaves explicit indents and answers without the flag alone", () => {
  const sections = [{ id: "s", heading: "(一)標題：", text: "乙".repeat(30), paragraphFormat: { firstLineIndent: 2 } }];
  const answer = createAnswerDocument({ templateId: standard.id, title: "explicit", sections });
  assert.deepEqual(layoutSections(standard, answer.sections, neat).lines.map(start), layoutSections(standard, answer.sections).lines.map(start));
  const plain = createAnswerDocument({ templateId: standard.id, title: "legacy", sections: skeleton });
  assert.ok(layoutSections(standard, plain.sections).lines.every(line => start(line) === 0));
});

function notes(sections: Parameters<typeof createAnswerDocument>[0]["sections"], options: object = neat) {
  const answer = { ...createAnswerDocument({ templateId: standard.id, title: "book", sections }), layoutOptions: options };
  const report = layoutSections(standard, answer.sections, options);
  return { notes: layoutQualityNotes(standard, answer, report).join("\n"), quality: scoreLayout(standard, answer, report) };
}

test("book-format notes: label headings, 壹、 and more than four levels", () => {
  const label = notes([{ id: "a", heading: "壹、前言", text: "內容。" }, { id: "b", heading: "貳、本文", text: "內容。" }, { id: "c", heading: "參、結論", text: "內容。" }]);
  assert.match(label.notes, /「壹、前言」、「貳、本文」、「參、結論」是功能標籤/);
  assert.match(label.notes, /不用「壹、」/);
  assert.equal(label.quality.bookFormatIssues, 2);
  const deep = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙：" }, { text: "1.丙：" }, { text: "⑴丁。" }, { text: "⑵丁。" }, { text: "2.丙。" }, { text: "(二)乙。" }] }]);
  assert.equal(deep.notes, "", "一、→(一)→1.→⑴ is a valid four-level answer");
  const tooDeep = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙：" }, { text: "1.丙：" }, { text: "⑴丁：" }, { text: "甲、戊。" }] }]);
  assert.match(tooDeep.notes, /用了 5 層；最多四層 一、→\(一\)→1\.→⑴/);
  const book = notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙：" }, { text: "(1)丙。" }, { text: "(2)丙。" }, { text: "2.乙。" }] }, { id: "end", text: "綜上所述。" }]);
  assert.equal(book.quality.bookFormatIssues, 0); assert.doesNotMatch(book.notes, /格式提醒/);
  assert.equal(notes([{ id: "a", heading: "壹、前言", text: "內容。" }], {}).quality.bookFormatIssues, 0, "older answers are not held to the books");
});

test("numbered points over two lines are flagged; one- and two-line points pass", () => {
  const point = (n: number) => notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: `(一)乙：${"丙".repeat(n)}` }, { text: `1.丁：${"戊".repeat(n)}` }] }]);
  assert.doesNotMatch(point(10).notes, /重點項超過 2 行/);
  const long = point(80);
  assert.match(long.notes, /「\(一\)乙：丙.*」、「1\.丁：戊.*」重點項超過 2 行；每個重點項寫一到兩行/);
  assert.doesNotMatch(notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: `(一)乙：${"丙".repeat(80)}` }] }], {}).notes, /重點項/, "older answers are not held to it");
});

test("a lone sub-item under a point is flagged; two or more pass", () => {
  const lone = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙：" }, { text: "1.丙。" }, { text: "(二)丁。" }] }]);
  assert.match(lone.notes, /「1\.丙。」是上一層底下唯一的子項/);
  const pair = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙：" }, { text: "1.丙。" }, { text: "2.戊。" }, { text: "(二)丁。" }] }]);
  assert.doesNotMatch(pair.notes, /唯一的子項/);
  assert.doesNotMatch(notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙：" }, { text: "1.丙。" }] }], {}).notes, /唯一的子項/, "older answers are not held to it");
});

test("pros and cons written as sentences are flagged; keyword lists pass", () => {
  const sentence = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)優點：不執行樣本，感染風險低。" }, { text: "(二)缺點：加殼混淆；難以逆向。" }] }]);
  assert.match(sentence.notes, /「\(一\)優點：不執行樣本，感染」、「\(二\)缺點：加殼混淆；難以逆」寫成句子；優缺點請以頓號並列關鍵詞/);
  const keywords = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)優點：低風險、快速初篩、便於比對。" }, { text: "(二)缺點：難證實際行為、易受混淆。" }] }]);
  assert.doesNotMatch(keywords.notes, /寫成句子/);
  assert.doesNotMatch(notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)優點：不執行樣本，感染風險低。" }, { text: "(二)缺點：甲、乙。" }] }], {}).notes, /寫成句子/, "older answers are not held to it");
});

test("review rv5: independent book notes, headless middle text is body, full-width brackets", () => {
  const both = notes([{ id: "s", heading: "壹、法規依據：", paragraphs: [{ text: "一、點" }, { text: "(一)項" }, { text: "1.目" }, { text: "(1)細目" }] }]);
  assert.match(both.notes, /整份答案不加總標題編號，不用「壹、」；子題大標請改為「一、」/); assert.match(both.notes, /用了 5 層/);
  const answer = createAnswerDocument({ templateId: standard.id, title: "mid", sections: [{ id: "intro", text: "前言。" },
    { id: "s1", heading: "(一)甲：", text: "乙。" }, { id: "mid", text: "丙".repeat(40) }, { id: "end", text: "綜上所述。" }] });
  const mid = layoutSections(standard, answer.sections, neat).lines.filter(line => line.sectionId === "mid");
  assert.ok(mid.length > 1 && mid.every(line => start(line) === 4), "headless text between body sections stays on the text line");
  assert.match(notes([{ id: "s", heading: "（一）甲：", text: "乙。" }]).notes, /半形/);
  const book = notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙：" }, { text: "(1)丙。" }, { text: "(2)丙。" }, { text: "2.乙。" }] }, { id: "end", text: "綜上所述。" }]);
  assert.equal(book.notes, "", "the book skeleton draws no structural or format note");
});

test("book notes: body points need a 大標, items each own a paragraph", () => {
  const terms = notes([{ id: "intro", text: "前言。" }, { id: "t1", text: "Locard 交換原理指出接觸會留下痕跡。" }, { id: "t2", text: "滲透測試是授權模擬攻擊。" }, { id: "end", text: "綜上所述。" }]);
  assert.match(terms.notes, /「Locard 交換原理指出接」、「滲透測試是授權模擬攻擊。」在本文中卻沒有大標/);
  const inline = notes([{ id: "intro", text: "前言。" }, { id: "a", text: "(一)甲：內容。" }, { id: "end", text: "綜上所述。" }]);
  assert.doesNotMatch(inline.notes, /沒有大標/, "a 大標 written inline at the paragraph start counts (最充實 format)");
  const restart = notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙。" }] }, { id: "b", paragraphs: [{ text: "1.丙。" }] }, { id: "end", text: "綜上所述。" }]);
  assert.match(restart.notes, /「1.丙。」在本文中卻沒有大標/); assert.doesNotMatch(restart.notes, /編號又從頭起算/, "one note per problem");
  assert.match(notes([{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "(1)乙。(2)丙。" }] }]).notes, /併在同一段/);
  const chinesePeers = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙。」(二)丙。" }] }]).notes;
  assert.match(chinesePeers, /一段內有多個編號項/); assert.doesNotMatch(chinesePeers, /併在同一段/, "one note per packed paragraph");
  const arabicInChinese = notes([{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "(一)乙：1.丙。2.丁。" }] }]).notes;
  assert.match(arabicInChinese, /併在同一段/); assert.doesNotMatch(arabicInChinese, /一段內有多個編號項/, "one note per packed paragraph");
  assert.doesNotMatch(notes([{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "(1)依第2條規定。" }] }]).notes, /併在同一段/);
});

test("a colon-ended 中標 over body text is not an embedded heading in neat answers", () => {
  const sections = [{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.組織策略：" }, { text: "納入數位轉型願景。" }, { text: "2.作業流程：" }, { text: "先小規模試辦。" }] }];
  assert.equal(notes(sections).quality.embeddedHeadingParagraphs, 0);
  assert.equal(notes(sections, {}).quality.embeddedHeadingParagraphs, 2, "older answers keep the earlier rule");
});

test("review rv6: decimals, stacked 中標 and a closing-less last section", () => {
  assert.doesNotMatch(notes([{ id: "s", heading: "(一)查處情形：", paragraphs: [{ text: "1.本案查扣共5公斤；1.5公斤為安非他命。" }] }]).notes, /併在同一段/);
  assert.match(notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙。" }] }, { id: "b", paragraphs: [{ text: "1.丙重起。" }] }]).notes, /編號又從頭起算/);
});

test("a far-over answer gets a cut plan that reaches capacity; a small overflow does not", async () => {
  const { summarizeLayout } = await import("../src/layout.js");
  const plan = (sections: Parameters<typeof createAnswerDocument>[0]["sections"]) => {
    const report = layoutSections(standard, createAnswerDocument({ templateId: standard.id, title: "far", sections }).sections, neat);
    const text = summarizeLayout(report, true);
    const cuts = new Map([...text.matchAll(/(\w+) (\d+)→(\d+) 行/gu)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
    return { report, text, cuts };
  };
  const long = (id: string, n: number, extra = {}) => ({ id, heading: "(一)標題：", text: "甲".repeat(n), ...extra });
  // A core section the hints protect stays untouched while a compressible one can absorb the overflow.
  const far = plan([long("core", 300, { required: true, priority: 5, compressible: 0 }), long("extra", 950, { required: false, priority: 1, compressible: 3 })]);
  assert.ok(far.report.overflowLines >= 5, far.text);
  assert.ok(!far.cuts.has("core"), far.text);
  const removed = [...far.cuts.values()].reduce((n, [from, to]) => n + from - to, 0);
  assert.equal(removed, far.report.overflowLines + 1, "cuts cover the overflow plus a spare line");
  assert.match(far.text, /一次 replace_texts 批次寫入/); assert.match(far.text, /已在容量內就停止/);
  assert.doesNotMatch(summarizeLayout(far.report), /超出較多/, "edit replies do not re-plan mid-way");
  // rv8: a protected section with a higher compressible score still waits behind unprotected ones.
  const order = plan([long("core", 300, { required: true, priority: 3, compressible: 3 }), long("extra", 700, { required: false, priority: 1, compressible: 2 })]);
  assert.ok(order.report.overflowLines >= 5 && order.cuts.has("extra") && !order.cuts.has("core"), order.text);
  // Far beyond what tightening can recover: say so instead of listing impossible targets.
  assert.match(plan([long("a", 3000)]).text, /先向使用者說明取捨/);
  let small = far.report;
  for (let n = 400; n < 2000 && !(small.overflowLines > 0 && small.overflowLines < 5); n += 5)
    small = layoutSections(standard, createAnswerDocument({ templateId: standard.id, title: "near", sections: [long("a", n)] }).sections, neat);
  assert.ok(small.overflowLines > 0 && small.overflowLines < 5);
  assert.doesNotMatch(summarizeLayout(small, true), /超出較多/);
});

test("format integrity: packed peers, duplicate headings and literal newlines", () => {
  for (const options of [neat, {}]) {
    for (const [text, items] of [["1.言論自由。2.資訊自主。3.安全求助。", "「2.」「3.」"], ["(1)甲；(2)乙。", "「(2)」"], ["（1）甲。（2）乙。", "「（2）」"],
      ["1.依學者見解：「保障人格權。」 2.資訊自主。", "「2.」"], ["1.甲。2、乙。3、丙。", "「2、」「3、」"], ["1.審查標準：(1)合法性。(2)合理性。", "「(2)」"], ["前言。1.甲。2.乙。", "「2.」"]])
      assert.ok(notes([{ text }], options).notes.includes(`格式提醒：第 1 節把${items}併在同一段；各點另起一段（paragraphs 各一項），若因此超頁改精簡各點措辭，不要併段。`), text);
    for (const text of ["1.依第2.1節辦理。", "1.甲；1.5公斤。", "1.甲。依第2.1節辦理。", "1.甲。\n2.乙。", "(一)甲。\n(二)乙。", "1.甲。(1)乙。",
      "1.審查標準：(1)合法性。", "(1)乙。1.丙。", "2.甲。1.乙。"])
      assert.doesNotMatch(notes([{ text }], options).notes, /併在同一段/);
    assert.match(notes([{ heading: "(二)甲：", text: "甲。" }, { heading: "（二）乙：", text: "乙。" }], options).notes, /大標編號或標題重複/);
    assert.match(notes([{ heading: "(二)備份與備援的差異：", text: "甲。" }, { heading: "(三)備份與備援的差異：", text: "乙。" }], options).notes, /大標編號或標題重複/);
    assert.doesNotMatch(notes([{ heading: "(一)甲：", text: "甲。" }, { heading: "(二)乙：", text: "乙。" }], options).notes, /大標編號或標題重複/);
    assert.doesNotMatch(notes([{ heading: "一、甲：", text: "甲。" }, { heading: "(一)意義：", text: "甲。" }, { heading: "二、乙：", text: "乙。" }, { heading: "(一)意義：", text: "乙。" }], options).notes, /大標編號或標題重複/, "(一) restarts under each 一、");
    assert.doesNotMatch(notes([{ heading: "(一)甲：", text: "甲。" }, { heading: "1.意義：", text: "甲。" }, { heading: "(二)乙：", text: "乙。" }, { heading: "1.意義：", text: "乙。" }], options).notes, /大標編號或標題重複/, "中標 titles may repeat under different 大標");
    assert.match(notes([{ heading: "(一)甲\\n乙", text: "甲。" }], options).notes, /字面.*真正分段/);
    assert.match(notes([{ paragraphs: [{ text: "甲\\n乙" }] }], options).notes, /字面.*真正分段/);
    assert.doesNotMatch(notes([{ text: "甲\n乙" }], options).notes, /字面/);
  }
});

test("lead: one line or over five prompt; closing: over two lines prompts; full essays only", () => {
  const own = "使用者提供的原稿或既有答案只向使用者建議，取得同意後才增寫。";
  const keep = "若因此超頁，開頭 2–3 句、結語 1–2 行即可，其餘從本文的套話與重複精簡，不刪必要論證。";
  const exempt = "法科實例題、計算題、名詞解釋題可不寫前言";
  const shortLead = `結構提醒：前言只有 1 行（${exempt}）；開頭寫 2–3 句（約 3–5 行）：先用「」框出本題核心概念並點出其意義或依據，再說明依此進行的程序或分析。${own}${keep}`;
  const longLead = (n: number) => `結構提醒：前言 ${n} 行；開頭 2–3 句（約 3–5 行）即可：先用「」框出本題核心概念並點出其意義或依據，再說明依此進行的程序或分析。${own}${keep}`;
  const kinds = "法科實例題、計算題寫明本案結論或計算結果即可，不必加建議；名詞解釋題可略過本則。";
  const longClose = (n: number) => `結構提醒：結語 ${n} 行；結語一到兩行即可，回扣題目所問，不新增論點。${own}${keep}`;
  const noLead = `結構提醒：沒有前言（${exempt}，略過本則）；其他題型請用 insert_text 新增不帶 heading 的節，再以 move_section 移到第一節之前，寫 2–3 句（約 3–5 行）：先用「」框出本題核心概念並點出其意義或依據，再說明依此進行的程序或分析，不重抄題目。${own}${keep}`;
  const noClose = `結構提醒：沒有結語；請用 insert_text（省略 afterSectionId 即加在最後）新增不帶 heading 的節，寫一到兩行回扣題目所問、收束本文已論證的判斷，不新增論點；${kinds}${own}${keep}`;
  const body = (n: number) => [
    { id: "s1", heading: "(一)第一點：", text: "乙".repeat(n) },
    { id: "s2", heading: "(二)第二點：", text: "丙".repeat(n) },
  ];
  const notesOf = (sections: Array<Record<string, unknown>>, question?: string, options: Record<string, unknown> = neat) => {
    const answer = { ...createAnswerDocument({ templateId: standard.id, title: "lead", question, sections: sections as never }), layoutOptions: options };
    return layoutQualityNotes(standard, answer, layoutSections(standard, answer.sections, options))
      .filter(note => note.startsWith("結構提醒") && /前言|結語/u.test(note));
  };
  const q25 = "一、試說明之。（25分）";
  // Standard sheet: 21 characters a line, 19 on an indented first line or body line.
  const lead1 = { id: "intro", text: "甲".repeat(15) }, lead2 = { id: "intro", text: "甲".repeat(30) }, lead3 = { id: "intro", text: "甲".repeat(50) };
  const lead6 = { id: "intro", text: "甲".repeat(110) };
  const close = (n: number) => ({ id: "end", text: `綜上所述，${"丁".repeat(n)}` });

  // Lead: two to five lines pass, one line or six prompt; closing: one or two lines pass, three prompt.
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", text: "綜上所述，丁丁" }], q25), []);
  assert.deepEqual(notesOf([lead3, ...body(110), close(25)], q25), []);
  assert.deepEqual(notesOf([lead1, ...body(110), close(25)], q25), [shortLead]);
  assert.deepEqual(notesOf([lead6, ...body(110), close(25)], q25), [longLead(6)]);
  assert.deepEqual(notesOf([lead2, ...body(110), close(40)], q25), [longClose(3)]);
  for (const note of [longClose(3), noClose]) { assert.doesNotMatch(note, /4–6 行|以「綜上」統整/); }
  // Missing on one side only; a first section opening with its own (一) is body, not a lead.
  assert.deepEqual(notesOf([...body(110), close(25)], q25), [noLead]);
  assert.deepEqual(notesOf([lead2, ...body(110)], q25), [noClose]);
  assert.deepEqual(notesOf([{ id: "s0", text: `(一)第零點：${"戊".repeat(40)}` }, ...body(110), { id: "s3", heading: "(三)第三點：", text: "己".repeat(40) }], q25), [noLead, noClose]);
  assert.deepEqual(notesOf([{ id: "s0", text: `一、第零點：${"戊".repeat(40)}` }, ...body(110), { id: "s3", heading: "三、第三點：", text: "己".repeat(40) }], q25), [noLead, noClose]);
  // A closing written as the last section's final 「綜上」 paragraph is moved out, not written twice.
  assert.deepEqual(notesOf([lead2, body(110)[0], { id: "s2", heading: "(二)第二點：", paragraphs: [{ text: "丙".repeat(110) }, { text: `綜上所述，${"丁".repeat(40)}` }] }], q25),
    ["結構提醒：最後一節末段「綜上所述，丁丁丁丁丁丁丁丁丁」是結語，卻寫在「(二)第二點：」節內；請用 replace_text 從該節刪去這段，再以 insert_text（省略 afterSectionId）新增不帶 heading 的節放入原文（內容照舊），不要另寫第二段結語。使用者提供的原稿或既有答案只向使用者建議，取得同意後才調整。"]);
  // A 「結論與建議」 heading marks the closing even when its points are listed as (一)(二).
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", heading: "(三)結論與建議：", paragraphs: [{ text: `(一)法制面：${"丁".repeat(10)}` }, { text: `(二)實務面：${"戊".repeat(10)}` }] }], q25), []);
  // Label headings mark the edges and only their body lines count; an empty trailing section is ignored.
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", heading: "結論：", text: "丁".repeat(30) }], q25), []);
  assert.deepEqual(notesOf([{ id: "intro", heading: "前言：", text: "甲".repeat(30) }, ...body(110), close(25)], q25), []);
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", heading: "(三)結論與建議：", text: "丁".repeat(30) }], q25), []);
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", heading: "(三)比較與結語：", text: "丁".repeat(30) }], q25), []);
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", heading: "(三)本案結論：", text: "丁".repeat(30) }], q25), []);
  assert.deepEqual(notesOf([lead2, ...body(110), { id: "end", heading: "(三)結論與建議：", text: "丁".repeat(30) }], q25), []);
  assert.deepEqual(notesOf([lead2, ...body(110), close(25), { id: "blank", text: "" }], q25), []);
  // The book note's "middle text without a 大標" check skips that blank section too.
  const blankAfter = { ...createAnswerDocument({ templateId: standard.id, title: "blank", question: q25, sections: [lead2, ...body(110), close(25), { id: "blank", text: "" }] as never }), layoutOptions: neat };
  assert.ok(!layoutQualityNotes(standard, blankAfter, layoutSections(standard, blankAfter.sections, neat)).some(note => note.includes("沒有大標")));
  // Full essays only: 15 points and up, or 20+ lines when the score is unknown; full-width digits count.
  assert.deepEqual(notesOf([lead6, ...body(110), close(25)], "一、試說明之。（15分）"), [longLead(6)]);
  assert.deepEqual(notesOf([lead1, ...body(150), close(25)], "一、試說明之。（14分）"), []);
  assert.deepEqual(notesOf([lead1, ...body(150), close(25)], "一、試說明之。（１０分）"), []);
  assert.deepEqual(notesOf([lead6, ...body(110), close(25)], "一、試說明之。（二十五分）"), [longLead(6)]);
  assert.deepEqual(notesOf([lead1, ...body(150), close(25)], "一、試說明之。（十分）"), []);
  assert.deepEqual(notesOf([lead1, ...body(130), close(25)]), []);
  assert.deepEqual(notesOf([lead2, ...body(130), close(25)]), []);
  assert.deepEqual(notesOf([lead6, ...body(150), close(25)]), [longLead(6)]);
  // A single section is left to the flattened-structure note; answers without neatFormat get nothing.
  assert.deepEqual(notesOf([{ id: "x", text: "甲".repeat(500) }], q25), []);
  assert.deepEqual(notesOf([lead1, ...body(110), close(25)], q25, {}), []);
  assert.deepEqual(notesOf(body(110), q25, {}), []);
});
