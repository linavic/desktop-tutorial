# חדשות נתניה – סיכום יומי

צנרת חצי-אוטומטית: כל ערב ב-20:00 נאספות ידיעות על נתניה, Claude מסכם את המהותיות, נוצר כרטיס לאינסטגרם,
ואתה מקבל **התרעה בטלגרם** עם התמונה והטקסט המוכן להדבקה בערוץ הווטסאפ.

```
RSS + Google News ──► סינון/כפילויות ──► סיכום Claude ──► כרטיס 1080x1350
                                                             │
                       ┌─────────────────────────────────────┤
                       ▼                                     ▼
        PUBLISH_MODE=instagram                       PUBLISH_MODE=draft
   פרסום אוטומטי באינסטגרם (Graph API)          (ברירת מחדל) טיוטה בלבד
                       └──────────────► התרעת טלגרם: תמונה + טקסט לווטסאפ ◄─┘
```

ווטסאפ: ל-API הרשמי אין פרסום לערוצים, לכן ההעברה לערוץ היא ידנית (העתק-הדבק של ההודעה מהטלגרם, 10 שניות).

## הרצה מקומית
```
pip install -r requirements.txt
python -m netanya_news.main --demo      # כרטיס לדוגמה בלי רשת, בתיקיית out/
python -m netanya_news.main --dry-run   # איסוף+סיכום אמיתיים, בלי פרסום והתרעה (דורש ANTHROPIC_API_KEY)
```

## הקמה (חד-פעמי)
1. **טלגרם (ההתרעה):** ב-@BotFather ליצור בוט ← `TELEGRAM_BOT_TOKEN`. לשלוח לבוט הודעה, ואז לפתוח
   `https://api.telegram.org/bot<TOKEN>/getUpdates` ולהעתיק את `chat.id` ← `TELEGRAM_CHAT_ID`.
2. **Claude:** `ANTHROPIC_API_KEY`.
3. ב-GitHub: Settings → Secrets and variables → Actions, מוסיפים את הסודות. ה-workflow רץ רק מהענף הראשי, לכן צריך למזג אליו.
4. מתחילים במצב טיוטה שבוע-שבועיים ובודקים איכות. אחר כך עוברים לפרסום אוטומטי:

### פרסום אוטומטי באינסטגרם (`PUBLISH_MODE=instagram`)
- חשבון אינסטגרם **Business/Creator** מקושר לדף פייסבוק, ואפליקציה ב-Meta for Developers עם ההרשאות
  `instagram_basic` ו-`instagram_content_publish`. לצורך השימוש בחשבון של עצמך מספיק מצב Development.
- סודות: `IG_USER_ID`, `IG_ACCESS_TOKEN` (long-lived, מתחדש כל ~60 יום).
- אינסטגרם דורשת כתובת ציבורית לתמונה, לכן התמונה עולה ל-bucket ציבורי ב-Supabase Storage
  (שם ברירת מחדל `netanya-news`): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` (אופציונלי).
- להפעלה: Settings → Variables → `PUBLISH_MODE` = `instagram`.

## התרעות
כל הרצה מסתיימת בהתרעת טלגרם: פורסם (עם קישור לפוסט), טיוטה מוכנה, אין חדשות משמעותיות, לא נאספו ידיעות, או כשל.

## התאמות
- מקורות: `sources.json` (שאילתות Google News ופידים). אפשר להוסיף מקומונים/אתר העירייה ופידי RSS ממקורות רשתות
  (למשל RSSHub או Apify), והם יסוננו לפי המילה "נתניה".
- הנחיות העריכה והטון: `SYSTEM` ב-`netanya_news/summarize.py`.
- המודל: משתנה סביבה `NEWS_MODEL`.

## הערות
- הכתיבה מבוססת רק על המקורות, והקישורים נבדקים מול הידיעות שנאספו. עדיין מומלץ להעיף מבט על ההודעה לפני העברה לווטסאפ.
- סיכום במילים שלנו עם קישור למקור, בלי העתקת טקסט או תמונות.
- הפונט Heebo ברישיון OFL (`fonts/OFL.txt`).
