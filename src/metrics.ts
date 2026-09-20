import type { AnswerTemplate } from "./domain.js";

export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;
const MM_PER_INCH = 25.4;

export interface GridMetrics {
  leftPt: number;
  topPt: number;
  contentWidthPt: number;
  availableHeightPt: number;
  rowHeightPt: number;
  contentHeightPt: number;
  bottomPt: number;
  columnWidthPt: number;
}

export function mmToTwips(mm: number): number {
  return Math.round(mm * 56.6929133858);
}

export function mmToPoints(mm: number): number {
  return mm * 72 / MM_PER_INCH;
}

export function pointsToTwips(points: number): number {
  return Math.round(points * 20);
}

export function gridMetrics(template: AnswerTemplate): GridMetrics {
  const leftPt = mmToPoints(template.marginsMm.left);
  const topPt = mmToPoints(template.marginsMm.top);
  const rightPt = A4_WIDTH_PT - mmToPoints(template.marginsMm.right);
  const availableHeightPt = A4_HEIGHT_PT - mmToPoints(template.marginsMm.top + template.marginsMm.bottom);
  const contentWidthPt = rightPt - leftPt;
  const rowHeightPt = template.lineHeightPt;
  const contentHeightPt = rowHeightPt * template.linesPerPage;

  if (contentHeightPt > availableHeightPt + 0.01) {
    throw new Error(
      `模板行高 ${rowHeightPt}pt × ${template.linesPerPage} 行超出 A4 可用高度 ${availableHeightPt.toFixed(2)}pt。`,
    );
  }

  return {
    leftPt,
    topPt,
    contentWidthPt,
    availableHeightPt,
    rowHeightPt,
    contentHeightPt,
    bottomPt: topPt + contentHeightPt,
    columnWidthPt: contentWidthPt / template.columns,
  };
}

