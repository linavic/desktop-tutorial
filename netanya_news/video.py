"""Vertical (1080x1920) news video: intro, one slide per item, outro. Silent, built with Pillow + ffmpeg."""
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

from .card import _font, _wrap, get_display, hebrew_date

VW, VH = 1080, 1920
SEC_PER_ITEM, SEC_BOOKEND = 5, 3


def _bg():
    img = Image.new("RGB", (VW, VH), "#0B2545")
    d = ImageDraw.Draw(img)
    for y in range(VH):
        d.line([(0, y), (VW, y)], fill=(11, 37 + int(30 * y / VH), 69 + int(40 * y / VH)))
    d.rectangle([0, 0, VW, 16], fill="#F4B942")
    return img, d


def _slide(kind, date, item=None, idx=0, n=0):
    img, d = _bg()
    m = 90
    if kind == "intro":
        d.text((VW - m, 700), get_display("חדשות נתניה"), font=_font(130, b"ExtraBold"), fill="white", anchor="ra")
        d.text((VW - m, 880), get_display("סיכום יומי"), font=_font(70, b"Medium"), fill="#F4B942", anchor="ra")
        d.text((VW - m, 990), get_display(hebrew_date(date)), font=_font(46, b"Regular"), fill="#9FB3C8", anchor="ra")
    elif kind == "outro":
        d.text((VW // 2, 820), get_display("הסיכום המלא וקישורים לכתבות"), font=_font(58, b"Bold"), fill="white", anchor="mm")
        d.text((VW // 2, 940), get_display("בערוץ חדשות נתניה"), font=_font(70, b"ExtraBold"), fill="#F4B942", anchor="mm")
    else:
        d.text((VW - m, 200), get_display(f"{idx} / {n}"), font=_font(44, b"Medium"), fill="#F4B942", anchor="ra")
        y = 520
        for line in _wrap(d, item["title"], _font(84, b"ExtraBold"), VW - 2 * m)[:4]:
            d.text((VW - m, y), get_display(line), font=_font(84, b"ExtraBold"), fill="white", anchor="ra")
            y += 112
        y += 50
        for line in _wrap(d, item.get("summary", ""), _font(48, b"Regular"), VW - 2 * m)[:5]:
            d.text((VW - m, y), get_display(line), font=_font(48, b"Regular"), fill="#C9D6E4", anchor="ra")
            y += 68
        d.text((VW - m, VH - 220), get_display("מקור: " + (item.get("source") or "")), font=_font(40, b"Medium"), fill="#F4B942", anchor="ra")
    return img


def render(items, date, out_path):
    """Returns out_path, or None when ffmpeg is unavailable."""
    if not shutil.which("ffmpeg"):
        return None
    slides = [("intro", None, SEC_BOOKEND)] + [("item", it, SEC_PER_ITEM) for it in items] + [("outro", None, SEC_BOOKEND)]
    with tempfile.TemporaryDirectory() as tmp:
        lines = []
        for k, (kind, it, secs) in enumerate(slides):
            path = os.path.join(tmp, f"s{k}.png")
            _slide(kind, date, it, k, len(items)).save(path)
            lines += [f"file '{path}'", f"duration {secs}"]
        lines.append(f"file '{os.path.join(tmp, f's{len(slides) - 1}.png')}'")  # concat demuxer needs the last frame repeated
        lst = os.path.join(tmp, "list.txt")
        open(lst, "w").write("\n".join(lines))
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                        "-vf", "fps=25,format=yuv420p", "-c:v", "libx264", "-movflags", "+faststart", out_path], check=True)
    return out_path
