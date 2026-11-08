# 166 PDF/SVG baseline calibration

> 歷史驗證紀錄：下文的 166 為當時的模板代碼或產物名稱，保留以供追溯。現行顯示名稱為 165，舊代碼僅供相容；目前狀態見 [第二輪名稱核對](template-name-165-audit-20261030.md)。

## Evidence and scope

The parent inspected the original reference and the deployed two-page preview using actual Library materializations. Across all 43 text rows the deployed baseline was 1.0428–1.7209pt lower (mean 1.5151pt). The difference is not uniform: the asset has irregular raster-derived row heights, whereas the reference text follows slightly different baseline increments. This does not establish that any PDF font metric is broken.

PDF and SVG previously used the bottom of each paper row minus a literal 3.5pt. The candidate changes that shared rendering inset to 5pt. This is an approximate visual calibration: a uniform 1.5pt upward shift reduces the measured systematic error without fitting individual rows or example paragraphs. Based on the parent's reference measurements the expected residual range is -0.4572 to +0.2209pt; an independent comparison of the actual candidate remains necessary.

The PDF and SVG use one baseline function because the canvas preview should agree with the exported PDF. Word retains its separate table geometry and spacing reserve. Template selection, font, size, wrapping, text, background, general output and stored answers are unchanged.

## Local validation

- Existing 22-row PDF/SVG test plus a two-page 44-row real-font regression pass. Every row keeps its original mixed-script text and PDF/SVG baseline agreement.
- The reference-text candidate renders as two pages with 22+21 rows. Each of the 666 extracted characters has exactly the same text, x position and 19pt size as the deployed local preview; every character moves up exactly 1.5pt. Background image bytes are unchanged.
- Both candidate pages were rendered at 120dpi and actually viewed on HP; no visible clipping or missing glyphs. HP still has not acquired the original reference pixels.
- The new officially saved comparison crop also failed at the official helper's download stage with `library file transfer failed: download failed`, exit 1 and no local bytes. It was not retried or fetched through another route.
- Native Word 16.0 previously rendered and passed the basic two-page visual check. This candidate changes no Word geometry; it does not assert exact Word/reference alignment.

Candidate outputs are in `output/pdf/baseline-candidate-20261029/`; they are QA artifacts, not included in the container build. Initial candidate SHA256: `caadb6aa454e6472d3d25c6ea165e9fadcb7e5f94fe94a8839f0a7176c530f50` (212429 bytes).

Library candidate identity: `libfile_853748ad33988191b3caf418b2b2bf7c`, `file_00000000f15882309bb72417d5e05c5e`, `/166-baseline-candidate.pdf`, version 0. Remote creation succeeded; local metadata application failed because Windows Python does not support `os.setxattr`. Library reports 236899 bytes, so byte identity is not assumed and there was no duplicate upload.

At preparation time this candidate is local and not deployed. Publish only after the parent completes the reference/candidate comparison and normal CI checks; do not claim pixel identity.
