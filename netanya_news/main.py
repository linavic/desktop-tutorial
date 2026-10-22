"""Daily pipeline: collect -> summarise -> card -> (publish to Instagram) -> alert owner."""
import argparse
import json
import os
import sys
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo

from . import card, collect, notify

TZ = ZoneInfo("Asia/Jerusalem")
STATE = "state/posted.json"
DEMO_ITEMS = [
    {"title": "עבודות תשתית בכביש החוף יגרמו לעומסים בערב", "summary": "דוגמה", "source": "דמו", "url": "https://example.com/1"},
    {"title": "עיריית נתניה אישרה תקציב לשדרוג גני השעשועים", "summary": "דוגמה", "source": "דמו", "url": "https://example.com/2"},
    {"title": "אירוע תרבות עירוני בשפת הים ביום שישי", "summary": "דוגמה", "source": "דמו", "url": "https://example.com/3"},
]


def _posted():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except FileNotFoundError:
        return {}


def alert(text):
    print(text)
    if notify.configured():
        try:
            notify.send_text(text)
        except Exception as e:
            print(f"[notify] failed: {e}", file=sys.stderr)


def run(args):
    now = datetime.now(TZ)
    if args.only_at_hour is not None and now.hour != args.only_at_hour:
        print(f"Israel time is {now:%H:%M}, not {args.only_at_hour}:00 - skipping (DST guard).")
        return 0
    day = f"{now:%Y-%m-%d}"
    if day in _posted() and not (args.force or args.demo):
        print(f"{day} already handled - skipping (use --force to override).")
        return 0

    if args.demo:
        result = {"skip": False, "items": DEMO_ITEMS,
                  "whatsapp_text": "*חדשות נתניה - סיכום יומי*\n\n(דמו)\n" + "\n".join(f"• {i['title']}" for i in DEMO_ITEMS),
                  "instagram_caption": "חדשות נתניה - סיכום יומי\n#נתניה #חדשות"}
    else:
        items = collect.collect()
        print(f"[main] {len(items)} unique recent items")
        if not items:
            alert(f"חדשות נתניה {day}: לא נאספו ידיעות. בדוק את המקורות.")
            return 1
        from .summarize import summarize
        result = summarize(items, card.hebrew_date(now))

    if result.get("skip"):
        alert(f"חדשות נתניה {day}: אין ידיעות משמעותיות - לא פורסם סיכום.")
        _save(day, "skipped")
        return 0

    image = card.render(result["items"], now, f"out/{day}.jpg")
    open(f"out/{day}-whatsapp.txt", "w", encoding="utf-8").write(result["whatsapp_text"])
    open(f"out/{day}-instagram.txt", "w", encoding="utf-8").write(result["instagram_caption"])
    print(f"[main] card: {image}")
    if args.dry_run or args.demo:
        return 0

    mode, link = os.environ.get("PUBLISH_MODE", "draft"), ""
    if mode == "instagram":
        from . import instagram
        link = instagram.publish(image, result["instagram_caption"], day)
        headline = f"✅ פורסם באינסטגרם: {link}\nעכשיו מעבירים לערוץ הווטסאפ: מצרפים את התמונה ומדביקים את הטקסט שבהודעה הבאה."
    else:
        headline = "📝 הסיכום היומי מוכן (מצב טיוטה). מפרסמים באינסטגרם ובווטסאפ ידנית: התמונה כאן, הטקסט בהודעה הבאה."
    if notify.configured():
        notify.send_package(headline, image, result["whatsapp_text"])
    else:
        print("[notify] Telegram not configured - no alert sent!", file=sys.stderr)
    _save(day, mode, link)
    return 0


def _save(day, status, link=""):
    os.makedirs("state", exist_ok=True)
    data = _posted()
    data[day] = {"status": status, "link": link}
    json.dump(data, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--demo", action="store_true", help="sample data, no network, writes to out/")
    p.add_argument("--dry-run", action="store_true", help="collect+summarise+card, no publish/alert")
    p.add_argument("--force", action="store_true")
    p.add_argument("--only-at-hour", type=int, help="run only if the Israel-time hour matches (DST guard for cron)")
    args = p.parse_args()
    try:
        sys.exit(run(args))
    except Exception:
        err = traceback.format_exc()
        alert("❌ חדשות נתניה: ההרצה היומית נכשלה\n" + err[-800:])
        sys.exit(1)


if __name__ == "__main__":
    main()
