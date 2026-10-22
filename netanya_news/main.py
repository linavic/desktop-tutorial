"""Daily pipeline: collect -> summarise -> card -> (publish to Instagram) -> alert owner."""
import argparse
import json
import os
import sys
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo

from . import card, collect, compose, notify, video

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
        result = {"skip": False, "items": DEMO_ITEMS}
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

    date_label = card.hebrew_date(now)
    result["whatsapp_text"] = compose.whatsapp(result["items"], date_label)
    result["telegram_html"] = compose.telegram_html(result["items"], date_label)
    result["instagram_caption"] = compose.instagram(result["items"], date_label)
    image = card.render(result["items"], now, f"out/{day}.jpg")
    open(f"out/{day}-whatsapp.txt", "w", encoding="utf-8").write(result["whatsapp_text"])
    open(f"out/{day}-instagram.txt", "w", encoding="utf-8").write(result["instagram_caption"])
    print(f"[main] card: {image}")
    try:
        vid = video.render(result["items"], now, f"out/{day}.mp4")
    except Exception as e:  # video is optional; never block the text/image post
        print(f"[main] video failed: {e}", file=sys.stderr)
        vid = None
    package = {"date": day, "date_label": date_label, "items": result["items"],
               "captions": compose.platforms(result["items"], date_label)}
    json.dump(package, open(f"out/{day}-package.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[main] video: {vid}")
    if args.dry_run or args.demo:
        return 0

    targets = [t.strip() for t in os.environ.get("PUBLISH_TARGETS", "").split(",") if t.strip()]
    links, errors = {}, {}
    for t in targets:  # each platform fails independently
        try:
            if t == "telegram":
                links[t] = notify.post_to_channel(image, result["telegram_html"]) or "ערוץ טלגרם"
            elif t == "instagram":
                from . import instagram
                links[t] = instagram.publish(image, result["instagram_caption"], day)
            elif t == "asbiz":
                from . import deliver
                links[t] = deliver.deliver(package, image, vid, day)
            else:
                raise ValueError(f"unknown target '{t}'")
        except Exception as e:
            errors[t] = str(e)[:300]
    if not targets:
        headline = "📝 הסיכום היומי מוכן (מצב טיוטה). מפרסמים ידנית: התמונה כאן, הטקסט בהודעה הבאה."
    else:
        lines = [f"✅ {t}: {l}" for t, l in links.items()] + [f"❌ {t}: {e}" for t, e in errors.items()]
        headline = "פורסם:\n" + "\n".join(lines)
        if "whatsapp" not in targets:
            headline += "\n\nלווטסאפ: מצרפים את התמונה ומדביקים את הטקסט שבהודעה הבאה."
    if notify.configured():
        notify.send_package(headline, image, result["whatsapp_text"])
        if vid:
            try:
                notify.send_video(vid, "סרטון קצר לרילס/טיקטוק")
            except Exception as e:
                print(f"[notify] video failed: {e}", file=sys.stderr)
    else:
        print("[notify] Telegram not configured - no alert sent!", file=sys.stderr)
    _save(day, ",".join(links) or ("failed" if errors else "draft"), json.dumps(links, ensure_ascii=False))
    return 1 if errors else 0


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
