---
name: gpt-image-gen
description: קריאה ל-OpenAI Images API ליצירת תמונה מ-prompt ושמירה כקובץ PNG. מקבל prompt ונתיב פלט. הסוכן יובל משתמש בו.
---

# gpt-image-gen

הסקיל רק שולח prompt ל-API ושומר תמונה. ניסוח ה-prompt ובחירת הסגנון הם תפקיד יובל.

## הגדרות (מקובץ `.env`)
| משתנה | חובה | תיאור |
|---|---|---|
| `OPENAI_API_KEY` | כן | מפתח API |
| `IMAGE_MODEL` | לא | שם המודל. ברירת מחדל `gpt-image-1`. אם יש לך גישה למודל חדש יותר, שים כאן את שמו |
| `IMAGE_SIZE` | לא | ברירת מחדל `1024x1024` |
| `IMAGE_QUALITY` | לא | ברירת מחדל `medium` |

שגיאת API היא כמעט תמיד מפתח, מכסה או הרשאת מודל, לא פורמט הקריאה. אל תשנה את המודל בשקט. דווח את השגיאה.

## קריאה
```bash
set -euo pipefail
OUT="yuval/outputs/<date>-<slug>.png"     # נתיב הפלט
PROMPT='<the prompt>'

KEY=$(grep '^OPENAI_API_KEY=' .env | head -n1 | cut -d= -f2-)
MODEL=$(grep '^IMAGE_MODEL=' .env | head -n1 | cut -d= -f2-); MODEL=${MODEL:-gpt-image-1}
SIZE=$(grep '^IMAGE_SIZE=' .env | head -n1 | cut -d= -f2-);   SIZE=${SIZE:-1024x1024}
QUALITY=$(grep '^IMAGE_QUALITY=' .env | head -n1 | cut -d= -f2-); QUALITY=${QUALITY:-medium}
[ -n "$KEY" ] || { echo "MISSING OPENAI_API_KEY"; exit 1; }   # לא מדפיסים את המפתח

mkdir -p "$(dirname "$OUT")"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"prompt":sys.argv[2],"size":sys.argv[3],"quality":sys.argv[4]}))' "$MODEL" "$PROMPT" "$SIZE" "$QUALITY")

curl -sS -X POST https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "$BODY" -o /tmp/image-resp.json

python3 -c 'import json,base64,sys
d=json.load(open("/tmp/image-resp.json"))
if "data" not in d: print(json.dumps(d.get("error",d))); sys.exit(1)
open(sys.argv[1],"wb").write(base64.b64decode(d["data"][0]["b64_json"]))' "$OUT"

[ -s "$OUT" ] && echo "OK: $(wc -c < "$OUT") bytes -> $OUT" || echo "FAILED: $OUT"
```

## פלט
נתיב, גודל בבתים והאם הצליח. בכשל: הודעת השגיאה מה-API, בלי המפתח.
