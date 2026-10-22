"""Render the daily Instagram card (1080x1350) with proper Hebrew RTL layout."""
import os
from bidi.algorithm import get_display as _bidi
from PIL import Image, ImageDraw, ImageFont, features

W, H = 1080, 1350
RAQM = features.check("raqm")  # Pillow does RTL shaping itself when libraqm is present


def get_display(t):
    return t if RAQM else _bidi(t)

FONT = os.path.join(os.path.dirname(__file__), "..", "fonts", "Heebo.ttf")
MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]
DAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]  # Monday=0


def hebrew_date(d):
    return f"יום {DAYS[d.weekday()]}, {d.day} ב{MONTHS[d.month - 1]} {d.year}"


def _font(size, weight=b"Bold"):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name(weight)
    return f


def _wrap(draw, text, font, width):
    lines, cur = [], ""
    for w in text.split():
        t = f"{cur} {w}".strip()
        if draw.textlength(get_display(t), font=font) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    return lines + [cur] if cur else lines


def render(items, date, out_path):
    img = Image.new("RGB", (W, H), "#0B2545")
    d = ImageDraw.Draw(img)
    for y in range(H):  # vertical gradient
        c = int(37 + 30 * y / H)
        d.line([(0, y), (W, y)], fill=(11, c, 69 + int(40 * y / H)))
    m = 80
    d.rectangle([0, 0, W, 14], fill="#F4B942")
    d.text((W - m, 70), get_display("חדשות נתניה"), font=_font(92, b"ExtraBold"), fill="white", anchor="ra")
    d.text((W - m, 185), get_display("סיכום יומי · " + hebrew_date(date)), font=_font(40, b"Medium"), fill="#F4B942", anchor="ra")
    d.line([(m, 255), (W - m, 255)], fill="#3D5A80", width=3)

    n = len(items)
    top, bottom = 290, H - 130
    slot = min((bottom - top) / n, 260)
    size = 50 if n <= 4 else 42
    for idx, it in enumerate(items):
        font = _font(size)
        y = top + idx * slot
        lines = _wrap(d, it["title"], font, W - 2 * m - 90)[:3]
        d.ellipse([W - m - 38, y + 14, W - m - 10, y + 42], fill="#F4B942")
        for j, line in enumerate(lines):
            d.text((W - m - 70, y + j * (size + 12)), get_display(line), font=font, fill="white", anchor="ra")
    d.text((W // 2, H - 70), get_display("עוקבים אחרי הערוץ לסיכום כל ערב"), font=_font(34, b"Medium"), fill="#9FB3C8", anchor="mm")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    img.save(out_path, "JPEG", quality=92)
    return out_path
