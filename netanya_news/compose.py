"""Build the post texts from verified items (never from free model text)."""
import html

TAGS = "#נתניה #חדשות_נתניה #חדשות #עיריית_נתניה"


def whatsapp(items, date_label):
    out = [f"*חדשות נתניה – סיכום יומי*\n{date_label}\n"]
    for i in items:
        out.append(f"• *{i['title']}*\n{i.get('summary', '')}\nמקור: {i.get('source', '')} {i['url']}\n")
    return "\n".join(out).strip()


def telegram_html(items, date_label):
    out = [f"<b>חדשות נתניה – סיכום יומי</b>\n{html.escape(date_label)}\n"]
    for i in items:
        src = html.escape(i.get("source") or "למקור")
        out.append(f"• <b>{html.escape(i['title'])}</b>\n{html.escape(i.get('summary', ''))}\n"
                   f"<a href=\"{html.escape(i['url'], quote=True)}\">מקור: {src}</a>\n")
    return "\n".join(out).strip()


def instagram(items, date_label):
    lines = [f"חדשות נתניה – סיכום יומי | {date_label}\n"] + [f"• {i['title']}" for i in items]
    return "\n".join(lines) + "\n\nהסיכום המלא וקישורים לכתבות בערוץ הטלגרם והווטסאפ שלנו.\n\n" + TAGS
