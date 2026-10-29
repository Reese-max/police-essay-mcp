"""Inspect actual synthetic PDFs; use Poppler externally for the page PNGs."""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
compact = lambda text: re.sub(r"\s+", "", text)
report = {"synthetic": True, "files": [], "all_text_preserved": True}
for item in manifest["files"]:
    filename = root / item["name"]
    reader = PdfReader(filename)
    assert len(reader.pages) == item["pages"], filename
    fonts = {}
    for page in reader.pages:
        for reference in page["/Resources"].get("/Font", {}).values():
            font = reference.get_object()
            descendants = font.get("/DescendantFonts", [])
            descriptor = (descendants[0].get_object() if descendants else font).get("/FontDescriptor")
            descriptor = descriptor.get_object() if descriptor else {}
            fonts[str(font.get("/BaseFont"))] = {"subtype": str(font.get("/Subtype")), "embedded": any(key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")), "to_unicode": "/ToUnicode" in font}
    pages = []
    with pdfplumber.open(filename) as pdf:
        for index, page in enumerate(pdf.pages):
            extracted = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            expected = item["expectedPageText"][index]
            identical = compact(extracted) == compact(expected)
            if not identical:
                report["all_text_preserved"] = False
            assert all(char["text"] != "\ufffd" for char in page.chars), filename
            grid = manifest.get("grid", {"leftPt": 15 * 72 / 25.4, "contentWidthPt": 180 * 72 / 25.4})
            pages.append({"page": index + 1, "width": float(page.width), "height": float(page.height), "expected_characters": len(compact(expected)), "extracted_characters": len(compact(extracted)), "text_identical_ignoring_whitespace": identical, "missing_characters": dict(Counter(compact(expected)) - Counter(compact(extracted))), "extra_characters": dict(Counter(compact(extracted)) - Counter(compact(expected))), "characters_outside_page": sum(c["x0"] < 0 or c["x1"] > page.width or c["top"] < 0 or c["bottom"] > page.height for c in page.chars), "characters_outside_grid_horizontally": sum(c["x0"] < grid["leftPt"] - 0.1 or c["x1"] > grid["leftPt"] + grid["contentWidthPt"] + 0.1 for c in page.chars), "text": extracted})
    record = {"name": item["name"], "pages": pages, "fonts": fonts, "font_warning": item["fontWarning"]}
    report["files"].append(record)
(root / "inspection.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"files": [{"name": f["name"], "pages": len(f["pages"]), "text_preserved": all(p["text_identical_ignoring_whitespace"] for p in f["pages"]), "fonts": f["fonts"]} for f in report["files"]], "all_text_preserved": report["all_text_preserved"]}, ensure_ascii=False, indent=2))
