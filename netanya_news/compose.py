"""Build the post texts from verified items (never from free model text)."""
import html

TAGS = "#נתניה #חדשות_נתניה #חדשות #עיריית_נתניה"


def whatsapp(items, date_label):
    out = [f"*חדשות נתניה – סיכום יומי*\n{date_label}\n"]
    for i in items:
        out.append(f"• *{i['title']}*\n{i.get('summary', '')}\nמקור: {i.get('source', '')} {i['url']}\n")
    return "\n".join(out).strip()


def telegram_html(items, date_label, limit=3500):
    """Returns a list of HTML messages, each under `limit` characters, split only between items."""
    head = f"<b>חדשות נתניה – סיכום יומי</b>\n{html.escape(date_label)}\n"
    parts, cur = [], head
    for i in items:
        src = html.escape(i.get("source") or "למקור")
        block = (f"• <b>{html.escape(i['title'])}</b>\n{html.escape(i.get('summary', ''))}\n"
                 f"<a href=\"{html.escape(i['url'], quote=True)}\">מקור: {src}</a>\n")
        if len(cur) + len(block) + 1 > limit and cur != head:
            parts.append(cur.strip())
            cur = ""
        cur += "\n" + block if cur else block
    parts.append(cur.strip())
    return parts


def instagram(items, date_label):
    lines = [f"חדשות נתניה – סיכום יומי | {date_label}\n"] + [f"• {i['title']}" for i in items]
    return "\n".join(lines) + "\n\nהסיכום המלא וקישורים לכתבות בערוץ הטלגרם והווטסאפ שלנו.\n\n" + TAGS


def platforms(items, date_label):
    """Ready-to-post captions per network. Telegram/WhatsApp keep full links; others point to the channel."""
    heads = [i["title"] for i in items]
    short = f"חדשות נתניה | {date_label}\n\n" + "\n".join(f"• {h}" for h in heads)
    x = f"חדשות נתניה – סיכום יומי\n" + "\n".join(f"• {h}" for h in heads[:2])
    return {
        "whatsapp": whatsapp(items, date_label),
        "instagram": instagram(items, date_label),
        "facebook": short + "\n\nהקישורים לכתבות המלאות בערוץ הטלגרם שלנו.",
        "tiktok": f"חדשות נתניה – סיכום יומי | {date_label}\n" + TAGS + " #fyp",
        "x": x[:270],
        "linkedin": short,
    }
