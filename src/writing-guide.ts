import {ESSAY_TEACHING_CASES,TASK_BOUNDARY_INSTRUCTION,APPLICABILITY_INSTRUCTION,MATERIAL_BOUNDARY_INSTRUCTION,COMPACT_PAPER_INSTRUCTION} from './essay-instructions.js';
export const WRITING_GUIDE_HINT = '\nwritingGuide已附三階段寫作指引、五題型示例與缺口紀錄格式；先依題型與限制規劃，再寫入答案。它只提供呼叫者指引，不自動判定內容或來源。';

/** Static caller guidance; never inspects an answer or calls a model/source. */
export function writingGuide() {
  return {
    version:'essay-guide-20261103.1',
    limits:{callerGuidanceOnly:true,automaticSemanticVerification:false,automaticSourceVerification:false,
      templateUnchanged:true,paperCapacityLines:44,capacityAppliesTo:'165/166原稿紙；其他模板以回傳template容量為準',recordedEvidenceMaxNoteCharacters:2000},
    stages:{
      draft:'先按每小問與指令動詞擬綱；依明確配分安排時間、核心篇幅與標題，先核心再深入，無配分不捏造。依題型選路徑，不要求全部出現：解釋看概念機制；比較逐共同維度對照；原因說明機制條件；對策對原因、執行與取捨；案例連結具體事實與要件，不重抄，只有真相關爭議才列不同見解。前言本文結論可選，不強制每段四句或案例。先論證後壓縮，不捏造法條、官方採點或高分保證。',
      compress:'先read_answer與check_layout，逐小問比較修改前後。先刪套話、重複與離題補充，再縮句；保護要件、否定條件、比較維度、推理與原因對策對應。不能只剩名詞、刪必要小問、縮字級或改165版面。fits只表示容量；每次修改後重查語義並重核review，不能複製舊checked。',
      review:'依原題、原句與實際材料逐項核對。將呼叫者發現記入對應requirements[].review.note，使用下列issueNoteTemplate；無法定位就寫待定位，不捏造原句或頁碼。未解決缺口用rejected；只有真正核對且該項問題已解決才用checked，未核對則省略證據。修改後review stale，實際重核後以最新expectedVersion呼叫set_answer_review，再review_answer。callerNote只是呼叫者原文，不是自動結論。',
    },
    paperLayout:{instruction:COMPACT_PAPER_INSTRUCTION,sectionExample:{id:'intro',text:'壹、前言：依職務需求配置權限，並保留複核程序。'},note:'同列範例省略heading；不是自動轉換或內容驗證。'},
    applicability:APPLICABILITY_INSTRUCTION,
    materialBoundaries:MATERIAL_BOUNDARY_INSTRUCTION,
    taskBoundaries:TASK_BOUNDARY_INSTRUCTION,
    issueNoteTemplate:{requirementId:'對應小問id',sectionIds:['相關section id'],
      quote:{sectionId:'原句所在section；無法定位則標待定位',text:'短原句；未核對不填造句',location:'段落或其他可核對位置；不捏造頁碼'},
      problem:'呼叫者判斷的具體問題',suggestedRevision:'可執行修法；缺證據則列待查，不擅自補事實',evidenceNeeded:['仍待核對的來源或事實']},
    saveInstructions:'issueNoteTemplate僅為格式，不能直接當證據保存。填入實際判斷後以文字或JSON字串放入既有review.note（最多2000字元），另照既有schema提供status/method/reviewer/checkedAt。read_answer可讀完整plan；review_answer以callerNote原樣回傳，reportedReview與freshness仍須一起看。semantic/sourceVerification仍not_checked。',
    examplesLabel:'自製教學示例，非官方高分範文或實測評分；不是本題的生成答案。',
    examples:ESSAY_TEACHING_CASES.filter(c=>c.id!=='dual_compression').map(c=>({type:c.type,question:c.question,material:c.material,teachingExample:c.teachingExample})),
  };
}
