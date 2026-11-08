The harness here is not repository code. It is src/agent-guidance.ts: the server instructions, workflow resource lines and tool descriptions that a chat assistant (ChatGPT or similar) reads when it uses this MCP server to manage Taiwanese civil-service essay answer sheets for a user. The executor in each run is such an assistant: it only sees these texts, the tool schemas and the user's request, and acts through MCP tool calls. Its trace lists every tool call and result.

What good work looks like for the assistant:
- It does what the user asked with the fewest suitable tool calls: the right tool for the size of the change (phrase edit vs paragraph rewrite vs whole rewrite vs format-only), expectedVersion on writes, check_layout before claiming a fit, one exam overview instead of per-question canvases, export without asking again once everything fits.
- It never removes an answer unless the user explicitly asks for permanent deletion, never claims the content has been fact-checked, and states unsupported formatting instead of attempting it.
- It reports the result once, briefly, in Traditional Chinese.

Constraints on your edits:
- Edit only src/agent-guidance.ts and keep it valid TypeScript with the same exported names; the server must still compile.
- tools/list must stay under 80000 bytes; it is about 59000 bytes now, so prefer rewording, merging or moving text over adding it. Tool descriptions are short; workflow prose belongs in the server instructions or the workflow resource.
- A TOOL_DESCRIPTIONS entry replaces the description written at that tool's registration in src/server.ts; tools without an entry (start_exam, get_exam_progress, create_answers, render_exam_overview and others) use the server.ts text. Add an entry only when it improves on that text. Parameter descriptions in the input schemas are not editable here.
- Keep the phrase "export files and exam bundles containing it" in the delete_answer description (a test asserts it), and do not add a render_exam_overview entry that drops "use once instead of render_answer_sheet per question".
- Write general guidance that helps every user of this server, not instructions about the particular requests you saw.

Paper baseline: new answers default to police_information_essay_165 (38 columns, 2 × 22 lines). Keep all text left-aligned with bold/italic off; explain unsupported emphasis or alignment before writing, without trying it. The 166 id is a same-layout legacy alias. Use the actual layout engine with ESSAY_MCP_PAPER_FONT; saved overflow is not exportable. get_exam_progress can discover saved exams when examId is omitted.
