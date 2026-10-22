"""Summarise the day's items into an Instagram card, caption and WhatsApp text via OpenAI or Claude."""
import json
import os
import re

OPENAI = bool(os.environ.get("OPENAI_API_KEY"))  # OpenAI if its key is set, otherwise Claude
MODEL = os.environ.get("NEWS_MODEL") or ("gpt-4.1" if OPENAI else "claude-sonnet-5-5")

SYSTEM = """אתה עורך חדשות של ערוץ "חדשות נתניה – סיכום יומי". תקבל רשימת ידיעות שנאספו היום ממקורות שונים.
כללים מחייבים:
- השתמש אך ורק בעובדות שמופיעות בידיעות. אל תמציא ואל תשלים פרטים. כל פריט חייב להתבסס על ידיעה אחת מהרשימה ולהחזיר את ה-url שלה בדיוק כפי שהופיע.
- בחר 3 עד 6 ידיעות המהותיות ביותר לתושבי נתניה (שירותים עירוניים, חינוך, תחבורה, כלכלה, אירועים גדולים, בטיחות הציבור). אחד ידיעות על אותו אירוע.
- התעלם מידיעות שאינן קשורות בפועל לנתניה.
- אל תכלול: עבירות מין, פגיעה בקטינים או על ידי קטינים, מוות שנסיבותיו לא ברורות או חשד להתאבדות, חקירות משטרה בלי פסק דין, או פרטים מזהים ופרטים גרפיים. אירוע פלילי או ביטחוני נכלל רק אם הוא משמעותי לציבור ופורסם רשמית.
- טון עיתונאי, ענייני וקצר, בעברית תקנית. בלי סימני קריאה ובלי קלישאות.
- אם אין חדשות מתאימות, החזר skip=true.
החזר JSON בלבד, בלי טקסט נוסף ובלי גדרות קוד, במבנה:
{"skip": false,
 "items": [{"title": "כותרת עד 60 תווים", "summary": "משפט אחד", "source": "שם המקור", "url": "הקישור המקורי"}]}"""


def _extract_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def summarize(items, date_label):
    payload = [{k: i[k] for k in ("title", "source", "url", "published", "snippet")} for i in items[:60]]
    user = f"תאריך: {date_label}\nידיעות:\n" + json.dumps(payload, ensure_ascii=False)
    if OPENAI:
        from openai import OpenAI
        r = OpenAI().chat.completions.create(
            model=MODEL, response_format={"type": "json_object"},
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}])
        text = r.choices[0].message.content
    else:
        import anthropic
        msg = anthropic.Anthropic().messages.create(
            model=MODEL, max_tokens=3000, system=SYSTEM, messages=[{"role": "user", "content": user}])
        text = "".join(b.text for b in msg.content if b.type == "text")
    result = _extract_json(text)
    valid_urls = {i["url"] for i in items}
    result["items"] = [i for i in result.get("items", []) if i.get("url") in valid_urls][:6]  # drop items without a real source
    if not result["items"]:
        result["skip"] = True
    return result
