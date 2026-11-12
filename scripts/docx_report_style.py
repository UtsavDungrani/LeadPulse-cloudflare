"""Shared Word styling for the LeadPulse evaluation reports.

Palette, cell shading, headings, bullets, code blocks, callouts and the table
builder. Split out of generate_ragas_eval_report.py so neither file carries the
whole report: this one owns how the document looks, that one owns what it says.
"""

from __future__ import annotations

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
from docx.shared import Inches, Pt, RGBColor

# --------------------------------------------------------------------------- #
# Palette and small docx helpers
# --------------------------------------------------------------------------- #

PRIMARY = RGBColor(15, 23, 42)
ACCENT = RGBColor(37, 99, 235)
BODY = RGBColor(51, 65, 85)
MUTED = RGBColor(100, 116, 139)
DANGER = RGBColor(185, 28, 28)
GOOD = RGBColor(21, 128, 61)

HEAD_FILL = "0F172A"
ZEBRA_FILL = "F1F5F9"
NOTE_FILL = "FEF3C7"
RULE = RGBColor(226, 232, 240)


def shade(cell, fill):
    cell._tc.get_or_add_tcPr().append(parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill}"/>'))


def cell_margins(cell, top=70, bottom=70, left=110, right=110):
    cell._tc.get_or_add_tcPr().append(parse_xml(
        f'<w:tcMar {nsdecls("w")}>'
        f'<w:top w:w="{top}" w:type="dxa"/><w:bottom w:w="{bottom}" w:type="dxa"/>'
        f'<w:left w:w="{left}" w:type="dxa"/><w:right w:w="{right}" w:type="dxa"/>'
        f'</w:tcMar>'))


def h1(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    r.font.size = Pt(14)
    r.font.bold = True
    r.font.color.rgb = PRIMARY
    return p


def h2(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(3)
    r = p.add_run(text)
    r.font.size = Pt(11)
    r.font.bold = True
    r.font.color.rgb = ACCENT
    return p


def para(doc, text, size=10.5, color=BODY, italic=False, space_after=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(space_after)
    r = p.add_run(text)
    r.font.size = Pt(size)
    r.font.color.rgb = color
    r.font.italic = italic
    return p


def bullet(doc, label, text):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.22)
    p.paragraph_format.space_after = Pt(4)
    lead = p.add_run("•  ")
    lead.font.color.rgb = ACCENT
    lead.font.bold = True
    if label:
        rl = p.add_run(f"{label} ")
        rl.font.size = Pt(10.5)
        rl.font.bold = True
        rl.font.color.rgb = PRIMARY
    rt = p.add_run(text)
    rt.font.size = Pt(10.5)
    rt.font.color.rgb = BODY


def code(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.left_indent = Inches(0.12)
    r = p.add_run(text)
    r.font.name = "Consolas"
    r.font.size = Pt(8.5)
    r.font.color.rgb = PRIMARY
    return p


def callout(doc, title, text, fill=NOTE_FILL):
    t = doc.add_table(rows=1, cols=1)
    t.autofit = True
    c = t.cell(0, 0)
    shade(c, fill)
    cell_margins(c, 120, 120, 150, 150)
    c.text = ""
    p = c.paragraphs[0]
    rt = p.add_run(f"{title}  ")
    rt.font.size = Pt(10)
    rt.font.bold = True
    rt.font.color.rgb = PRIMARY
    rb = p.add_run(text)
    rb.font.size = Pt(10)
    rb.font.color.rgb = BODY
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def table(doc, headers, rows, widths=None, right_cols=(), font=8.6):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    hdr = t.rows[0].cells
    for i, text in enumerate(headers):
        shade(hdr[i], HEAD_FILL)
        cell_margins(hdr[i])
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        if i in right_cols:
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        r = p.add_run(text)
        r.font.size = Pt(font)
        r.font.bold = True
        r.font.color.rgb = RGBColor(255, 255, 255)
    for n, row in enumerate(rows):
        cells = t.add_row().cells
        for i, val in enumerate(row):
            if n % 2 == 1:
                shade(cells[i], ZEBRA_FILL)
            cell_margins(cells[i])
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            if i in right_cols:
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            text = "" if val is None else str(val)
            bold = text.startswith("**")
            text = text.strip("*")
            r = p.add_run(text)
            r.font.size = Pt(font)
            r.font.bold = bold
            r.font.color.rgb = (
                DANGER if text in ("FAIL",) else GOOD if text in ("pass",) else BODY
            )
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t

