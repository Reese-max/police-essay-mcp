import type { AnswerDocument } from "./domain.js";

export type ExportFormat = "docx" | "pdf" | "txt";

/** A readable download name such as 114年警察特考_第1題_資訊系統可行性評估.docx; characters no OS accepts become _. */
export function answerFileName(answer: Pick<AnswerDocument, "title" | "exam" | "questionNo">, format: ExportFormat): string {
  const parts = [answer.exam, answer.questionNo === undefined ? undefined : `第${answer.questionNo}題`, answer.title];
  const base = parts.filter((part): part is string => Boolean(part?.trim()))
    .join("_")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  const name = Array.from(base || "申論答案").slice(0, 80).join("");
  // Windows refuses device names such as CON or COM1 before the first dot, whatever follows ("CON.notes.pdf").
  return `${name.replace(/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)/iu, "$1_")}.${format}`;
}

/** Orders answers by exam, then question number, then title; answers without an exam come last. */
export function sortAnswers<T extends Pick<AnswerDocument, "title" | "exam" | "questionNo">>(answers: T[]): T[] {
  return [...answers].sort((left, right) => (left.exam === undefined ? 1 : 0) - (right.exam === undefined ? 1 : 0)
    || (left.exam ?? "").localeCompare(right.exam ?? "", "zh-Hant")
    || (left.questionNo ?? Number.MAX_SAFE_INTEGER) - (right.questionNo ?? Number.MAX_SAFE_INTEGER)
    || left.title.localeCompare(right.title, "zh-Hant"));
}

/** 【exam】 headers with one line per answer, for list_answers. */
export function describeAnswerList(answers: Array<Pick<AnswerDocument, "id" | "title" | "exam" | "questionNo" | "version">>): string[] {
  const lines: string[] = [];
  let group: string | undefined | null = null;
  for (const answer of sortAnswers(answers)) {
    if (answer.exam !== group) {
      group = answer.exam;
      lines.push(`【${group ?? "未分類"}】`);
    }
    lines.push(`・${answer.questionNo === undefined ? "" : `第${answer.questionNo}題 `}「${answer.title}」（${answer.id}，第 ${answer.version} 版）`);
  }
  return lines;
}

/** What changed in the title, question, exam or question number between two versions. */
export function describeInfoChanges(before: AnswerDocument, after: AnswerDocument): string[] {
  const lines: string[] = [];
  const quoted = (value: string | undefined) => value === undefined ? "未設定" : `「${value}」`;
  if (before.title !== after.title) lines.push(`標題：${quoted(before.title)}→${quoted(after.title)}`);
  if (before.exam !== after.exam) lines.push(`考試：${quoted(before.exam)}→${quoted(after.exam)}`);
  if (before.questionNo !== after.questionNo) {
    const number = (value: number | undefined) => value === undefined ? "未設定" : `第 ${value} 題`;
    lines.push(`題號：${number(before.questionNo)}→${number(after.questionNo)}`);
  }
  if (before.question !== after.question) lines.push(after.question === undefined ? "題目：已清除" : before.question === undefined ? "題目：已設定" : "題目：已修改");
  return lines;
}
