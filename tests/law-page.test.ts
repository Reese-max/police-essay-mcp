import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEffectiveNote } from "../scripts/law-page.js";

const row = (tr: string, memo: string) => `<table><tr id="trLNNDate"><th>修正日期：</th><td>民國 114 年 11 月 11 日 </td></tr>${tr} <th>生效狀態： </th> <td class="text-danger"> <p> ※本法規部分或全部條文尚未生效，最後生效日期：未定 <a id="hyLawCon" href="/x">連結舊法規內容</a> </p> ${memo} </td> </tr></table>`;
const memo = (open: string, br = "<br />") => `${open} 1.一百十二年五月三十一日增訂之第&nbsp;1-1&nbsp;&nbsp;條條文，施行日期，由行政院定之。${br}2.一百十四年十一月十一日修正第&nbsp;12、18&nbsp;&nbsp;條條文，施行日期，由行政院定之。${br} </div>`;
const NOTE = "※本法規部分或全部條文尚未生效，最後生效日期：未定\n1.一百十二年五月三十一日增訂之第1-1條條文，施行日期，由行政院定之。\n2.一百十四年十一月十一日修正第12、18條條文，施行日期，由行政院定之。";

test("the 生效狀態 warning is kept verbatim, and markup variants do not lose any line", () => {
  assert.equal(parseEffectiveNote(row(`<tr id="VaildState">`, memo(`<div class="law-vaildMemo">`))), NOTE);
  assert.equal(parseEffectiveNote(row(`<tr id="VaildState" class="warning">`, memo(`<div class="law-vaildMemo expanded">`, "<BR class=\"x\">"))), NOTE);
  assert.equal(parseEffectiveNote(`<table><tr id="trLNNDate"><td>民國 115 年 05 月 13 日</td></tr></table>`), undefined); // law fully in force
});

test("a page that still mentions the warning but no longer parses fails loudly instead of dropping it", () => {
  assert.throws(() => parseEffectiveNote(`<div id="VaildState">※本法規部分或全部條文尚未生效</div>`), /生效狀態/);
  assert.throws(() => parseEffectiveNote(row(`<tr id="VaildState">`, memo(`<section class="law-vaildMemo">`).replace("</div>", "</section>"))), /生效狀態/);
  assert.throws(() => parseEffectiveNote(`<table><tr id="VaildState"></tr></table>`), /生效狀態/);
  assert.throws(() => parseEffectiveNote(row(`<tr id="VaildState">`, `<div class="law-vaildMemo"> <br /> </div>`)), /生效狀態/); // memo emptied
});

test("look-alike attributes and classes are not mistaken for the warning, and body text alone is no layout change", () => {
  const decoys = `<tr data-id="VaildState" id="history"><td><p>歷史沿革</p></td></tr>`;
  assert.equal(parseEffectiveNote(decoys + row(`<tr id="VaildState">`, `<div class="law-vaildMemo-header">說明</div>` + memo(`<div class="law-vaildMemo">`))), NOTE);
  assert.equal(parseEffectiveNote(`<div class="law-article">契約尚未生效時之處理</div>`), undefined);
  const linked = row(`<tr id="VaildState">`, memo(`<div class="law-vaildMemo">`)).replace("※本法規部分", `※本法規<a href="/info">部分</a>`);
  assert.equal(parseEffectiveNote(linked), NOTE); // only the 舊法規 button ends the summary
});
