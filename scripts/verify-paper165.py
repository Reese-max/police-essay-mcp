"""Verify a rendered 165 PDF against its shared layout; requires PyMuPDF.
Usage: python scripts/verify-paper165.py layout.json rendered.pdf
Run on both native PDF and Word/LibreOffice-converted PDF before delivery.
"""
import json, pathlib, sys
import fitz
layout = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
asset = json.loads((pathlib.Path(__file__).resolve().parents[1] / 'assets/paper_166.asset.json').read_text())
compact = lambda s: ''.join(s.split())
with fitz.open(sys.argv[2]) as document:
    assert layout['fits'] and layout['totalLines'] <= 44, 'Layout must fit 44 lines'
    assert len(document) == 2, f'Expected 2 pages, got {len(document)}'
    for page_index, page in enumerate(document):
        expected = [l for l in layout['lines'] if l['page'] == page_index + 1 and l['text'] and not l['isSpacer']]
        actual = [line for block in page.get_text('dict')['blocks'] if 'lines' in block for line in block['lines'] if compact(''.join(s['text'] for s in line['spans']))]
        assert len(actual) == len(expected), f'Page {page_index+1}: text-line count differs'
        for line, planned in zip(actual, expected):
            text = ''.join(s['text'] for s in line['spans'])
            assert compact(text) == compact(planned['text']), f'Page {page_index+1}, row {planned["lineOnPage"]}: missing or changed text'
            left, top, right, bottom = line['bbox']
            row_top, row_bottom = asset['rows'][planned['lineOnPage'] - 1]
            # Font bounding boxes can exceed the painted glyph by a fraction of a point.
            assert left >= 130.32 - 1 and right <= 496 + 1, 'Text outside safe horizontal region'
            assert top >= row_top - 1 and bottom <= row_bottom + 2, f'Text outside row {planned["lineOnPage"]}'
print('PASS: two pages, complete text, each line inside its intended writing row')
