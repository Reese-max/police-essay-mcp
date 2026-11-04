# General PDF 中文斜體本機候選

此功能為預設關閉的可選模式。165/166稿紙仍禁止斜體，字型、字級及幾何不變。

預設不變：未提供可用的 ESSAY_MCP_PDF_ITALIC_FONT 時，以原字型輸出並保留缺斜體警告。已配置的斜體字型若缺少斜體正文所需字元，現在會拒用該字型並保留警告，避免Latin italic字型造成中文缺字。此涵蓋檢查不是對字型授權或設計真偽的認證。

只在本機明確設定 ESSAY_MCP_PDF_SYNTHETIC_ITALIC=true 時，general PDF可在無可用italic字型且有可用regular字型時，以PDFKit oblique選項傾斜12度。這是合成斜體，不是真italic字型；fontWarning明確標示。有效的已配置italic字型優先。未改儲存原文、字級、換行、DOCX格式或預設服務設定。

合成保持原文字advance及基線；齊行/右對齊或接近邊界時，筆畫可能伸出文字範圍。另回傳保守風險估計，與既有「實際寬度超出」警告分開，不縮字、不裁字、不偷偷分行。不能以fits宣稱字形或語義通過。

授權核對：本機QA使用既有固定隔離映像內的NotoSansCJK-Regular.ttc，選取NotoSansCJKtc-Regular face，及其fonts-noto-cjk套件copyright。官方Noto CJK Sans LICENSE為SIL OFL1.1，允許按條件嵌入；若日後分發字型本體需保留授權/版權等條件。此實作未改寫/分發新的italic字型檔，而是在PDF文字矩陣傾斜原face。

- PDFKit官方選項：https://pdfkit.org/docs/text.html
- Noto CJK官方授權：https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE

可攜性：PDF嵌入TC字型subset及向量傾斜，讀者不需安裝相同字型。實際兩頁off/on測例均14pt、26行、原文及逐字基線位置保持一致。DOCX XML未改；隔離LibreOffice渲染雖有斜體，卻使用Noto CJK JP/DejaVu fallback，顯示Word端仍依字型環境而變，不能承諾與PDF像素相同。尚未在iPhone、Acrobat或原生Microsoft Word全面驗收，亦未測所有真italic字型及粗斜體組合。
