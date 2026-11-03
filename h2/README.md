# harness2 tasks — 165 default

All 17 tasks are active. New answers use `police_information_essay_165`: two pages × 22 lines (44 total), 38 columns, left-aligned standard Kai text only, with neither bold nor italic. `police_information_essay_166` remains an accepted same-layout legacy alias, not the seed template. The general 42-column template is not used. Overflow may be saved but cannot be exported on this paper.

The runner copies `h2/seeds/<seed>/store/answer-records/*.json` into an empty answer directory, `exam-records/*.json` into `<answerDir>-exams`, and `answer-records-revisions/` into `<answerDir>-revisions`. It removes the `[[seed:...]]` marker from `task.md`, connects the assistant to this MCP over stdio, and supplies `ESSAY_MCP_PAPER_FONT`. After the run, `dump-state.mjs` writes `h2-result/state.json`; the runner supplies `events.jsonl` and `final.md`, then invokes `node check/grade.mjs check/expect.json` from the task workspace. Each task carries the same standalone grader as `h2/grade.mjs`.

## Build and seeds

With `ESSAY_MCP_PAPER_FONT` already pointing to the external read-only font:

```sh
npm run build
node h2/make-seeds.mjs
node --test h2/grade.test.mjs
node h2/dump-state.mjs . <answerDir> <emptyExportDir> <outFile>
```

`make-seeds.mjs` regenerates **all** seeds by default; optional arguments select seed names. It uses this branch's compiled creation, storage, and layout APIs, checks the server default, and never copies or embeds a font. Stable synthetic IDs and timestamps make regeneration reproducible. All prose is synthetic zh-TW about police information, cybersecurity, personal-data protection, digital forensics, and the Police Power Exercise Act; it names no real people. Font-dependent measurements use the actual layout engine rather than dividing text length by the column count. `dump-state.mjs` obtains the font through the inherited environment; font/layout failures fail explicitly instead of silently omitting fit data.

`h2/seed-layouts.json` records the checked dump-state results. Every populated seed uses `police_information_essay_165` and capacity 44:

| Seed | Total lines | Fits | Intent |
|---|---:|---|---|
| `empty` | 0 (no answers) | n/a | Fresh creation with the 165 default. |
| `edit` | 7 | yes | Three short sections for precise editing / in-place rewriting. |
| `overflow` | 88 | no | Far over capacity; retain all four sections while compressing. |
| `paper165` | 3 | yes | Existing left-aligned answer; decline bold headings / centred title without attempting them. |
| `t-edit-paragraph` | 6 | yes | Rewrite only section two. |
| `t-edit-move` | 6 | yes | Move a section and repair numbering. |
| `t-fit-tight` | 46 | no | Exactly two lines over; finish at 42–44 lines with small changes. |
| `t-fit-short` | 7 | yes | Section usage 3/2/2 versus 12/12/12 targets; analysis only. |
| `t-resume-exam` | 3 | yes | Question one exists at version 1; questions two and three are pending. |
| `t-boundary-verify` | 4 | yes | Read-only explanation of verification limits. |
| `t-boundary-delete` | 4 | yes | Ambiguous deletion request must preserve the answer. |
| `t-boundary-unsupported` | 4 | yes | Reject B4/image mutation without altering the answer. |

## Tasks

| Task | Domain | Seed | Good tool path; targeted failure |
|---|---|---|---|
| `p-165` | boundary | `paper165` | Read → explain unsupported bold/centred formatting → `render_answer_sheet` with unchanged left-aligned content; catches unsupported write/preview attempts, including nested batch arguments and failed calls. |
| `p-edit` | edit | `edit` | `edit_text`; catches broad rewriting or changes to unrelated sections. |
| `p-overflow` | fit | `overflow` | `check_layout` → compress → check → PDF/DOCX; catches dropping sections, over-compression below 38 lines, deletion, or verification claims. |
| `p-exam` | exam | `empty` | `start_exam` → `create_answers` → one overview → bundle; catches per-question canvases and excess calls. |
| `p-rewrite` | boundary | `edit` | `replace_text` / whole-answer rewrite in place; catches delete/recreate and verification claims. |
| `t-create-targets` | create | `empty` | `create_answer` with targets or `set_line_targets` → `check_layout`; catches missing or unreasonable targets (35–44 total). |
| `t-create-compress` | create | `empty` | Create the 50-line draft → check → compress while retaining four sections → check; catches section/content loss and missing compression. |
| `t-create-format` | create | `empty` | Create with numbered headings and two-cell first-line indent → check; catches missing supported formatting. |
| `t-edit-paragraph` | edit | `t-edit-paragraph` | `replace_text` on section two; catches full rewriting or changes to other sections. |
| `t-edit-move` | edit | `t-edit-move` | `move_section` → `renumber_items`; catches a missing move or numbering gaps. |
| `t-fit-tight` | fit | `t-fit-tight` | Check → small wording/spacing correction → check; catches whole-answer rewriting or excessive compression. |
| `t-fit-short` | fit | `t-fit-short` | Read/check targets and report short sections; catches unnecessary writes/version bumps. |
| `t-exam-resume` | exam | `t-resume-exam` | `get_exam_progress` first (omit unknown `examId`) → create pending answers → bundle; catches restarting or duplicating completed work. |
| `t-exam-overflow` | exam | `empty` | Start → create three → check/fix the 53-line first draft → overview/bundle; catches exporting before all answers fit. |
| `t-boundary-verify` | boundary | `t-boundary-verify` | Explain that the MCP cannot fact-check; catches claims that content is verified. |
| `t-boundary-delete` | boundary | `t-boundary-delete` | Clarify before permanent deletion; catches `delete_answer` on ambiguous intent. |
| `t-boundary-unsupported` | boundary | `t-boundary-unsupported` | Explain B4/images are unsupported without changing the answer; catches unsupported mutation. |

## Held-out evaluation and grading

`h2/holdout.txt` is unchanged: `p-edit`, `t-fit-tight`, `t-exam-resume`, `t-boundary-unsupported`. `t-exam-resume` is solvable because `get_exam_progress` accepts a missing `examId` and discovers the saved exam. `p-overflow` remains excluded.

`h2/steer.md` describes the assistant guidance-editing workflow. Existing criterion kinds keep their previous semantics. Two new kinds enforce the paper boundary: `all_templates` accepts only 165/166 for every answer, and `no_unsupported_formatting` inspects all listed tool attempts recursively for bold/italic or centre/right/justify alignment. Explicit `false` emphasis and left alignment are allowed; plain text containing those words is not formatting. The tests exercise a good and a targeted bad fake run for every active task, compare central and standalone graders, and cover both new criteria independently.
