# מערכת הסוכנים שלי

Claude קורא את הקובץ הזה בתחילת כל סשן. הוא "המוח" של המערכת: מי הצוות, איך מנתבים משימות, ואיך סוכנים מעבירים עבודה זה לזה.

## הקשר
- **העסק:** סוכנות/פרילנס דיגיטלית לעסקים. שלושה שירותים: (1) אוטומציות לעסקים, (2) בוטים בוואטסאפ ובטלגרם (כולל בוטי AI), (3) עיצוב ובניית אתרים.
- **קהל יעד:** בעלי עסקים קטנים ובינוניים בישראל שמבזבזים זמן על עבודה ידנית (מענה ללקוחות, תיאום, לידים) ורוצים אתר או בוט שמביאים לקוחות. לא טכניים.
- **קול ומותג:** <למלא. ברירת מחדל מוצעת: מקצועי, ישיר וחם, בלי ז'רגון טכני מיותר, עברית בגובה העיניים>
- **מה הלקוח באמת קונה:** חיסכון בזמן, פחות לידים שנופלים, מענה מהיר 24/7. מדברים בתוצאה, לא בכלים.
- **שפה:** עברית כברירת מחדל. אנגלית כשהפרויקט דורש.

---

# צוות התוכן (שיווק עצמי של העסק)

## הצוות (השרשרת)
חמישה סוכנים בשרשרת. כל סוכן מקבל קלט מהשלב הקודם וכותב פלט לשלב הבא:

```
משתמש → מנהל → חוקר → כותב → עורך → מפיץ
        brief   research  draft   final   distribution
```

| # | סוכן | קובץ | קלט | פלט |
|---|------|------|-----|-----|
| 1 | **מנהל** (orchestrator) | `.claude/agents/orchestrator.md` | בקשת תוכן | `content/briefs/<slug>.md` |
| 2 | **חוקר** (researcher) | `.claude/agents/researcher.md` | הבריף | `content/research/<slug>.md` |
| 3 | **כותב** (writer) | `.claude/agents/writer.md` | בריף + מחקר | `content/drafts/<slug>.md` |
| 4 | **עורך** (editor) | `.claude/agents/editor.md` | טיוטה + בריף | `content/final/<slug>.md` |
| 5 | **מפיץ** (publisher) | `.claude/agents/publisher.md` | גרסה סופית | `content/final/<slug>.distribution.md` |

## איך מריצים (תבנית העבודה החשובה)
> ⚠️ בקלוד קוד **סוכן (subagent) לא יכול להפעיל סוכן אחר.**
> לכן **המנהל האמיתי הוא הסשן הראשי הזה**: הוא מריץ את הסוכנים לפי הסדר.

הזרימה:
1. המשתמש נותן בקשת תוכן (או מריץ `/create-content <נושא>`).
2. הסשן הראשי קורא ל-**orchestrator** → בריף ב-`content/briefs/<slug>.md`.
3. הסשן הראשי קורא ל-**researcher** → `content/research/<slug>.md`.
4. הסשן הראשי קורא ל-**writer** → `content/drafts/<slug>.md`.
5. הסשן הראשי קורא ל-**editor** → `content/final/<slug>.md`.
6. הסשן הראשי קורא ל-**publisher** → התאמות פרסום.

**ההעברה בין סוכנים נעשית דרך קבצים**: כל שלב כותב קובץ והשלב הבא קורא אותו. זה הלב של התבנית: handoff דרך מערכת הקבצים, לא דרך זיכרון משותף.

---

## יעל, כותבת התוכן (flow עצמאי)
סוכנת נפרדת מהשרשרת. לוקחת **מאמר גלם** ומשכתבת אותו בסגנון הצוות.

| סוכן | קובץ | קלט | פלט |
|------|------|-----|-----|
| **יעל** (yael) | `.claude/agents/yael.md` | מאמר גלם מ-`content/` | `Output/<name>.md` + `Output/<name>.html` |

- תיקיית עבודה: `yael/`: `style-guide.md` (מדריך סגנון) ו-`reference/` (דוגמאות). יעל קוראת אותם בתחילת כל משימה.
- יעל קוראת **רק קבצי מאמר בודדים** בשורש `content/` ומתעלמת מתיקיות השרשרת.
- **מילות הפעלה:** שכתב, ערוך, נסח מחדש, תרגם, סכם, מאמר, תוכן, פוסט / rewrite, edit, translate, summarize, article, post

## יובל, מעצב התמונות (flow עצמאי)
מייצר תמונות דרך OpenAI Images API, עם **עקביות ויזואלית** מבוססת reference.

| סוכן | קובץ | קלט | פלט |
|------|------|-----|-----|
| **יובל** (yuval) | `.claude/agents/yuval.md` | בקשת תמונה / prompt | `yuval/outputs/<YYYY-MM-DD>-<slug>.png` + `.txt` |

- תיקיית עבודה: `yuval/`: `reference/` (תמונות השראה) ו-`outputs/` (תמונות מוגמרות). יובל סורק את ה-reference בתחילת כל בקשה.
- קורא לסקיל `.claude/skills/gpt-image-gen/`. דורש `OPENAI_API_KEY` ב-`.env` (תבנית ב-`.env.example`). שם המודל נקבע ב-`IMAGE_MODEL`.
- **מילות הפעלה:** תמונה של, ציור של, תיצור תמונה, איור / image of, generate image, illustration

### חיבור יעל ↔ יובל (מאמר עם תמונות)
1. הסשן הראשי מפעיל את **יעל**.
2. יעל מסמנת `{{IMAGE_NEEDED: "תיאור + סגנון"}}` ומחזירה סיכום ורשימת placeholders.
3. הסשן הראשי מפעיל את **יובל** לכל placeholder (placeholder אחד = תמונה אחת).
4. הסשן הראשי משלב את התמונות בקבצי ה-MD וה-HTML, ושומר ב-`Output/`.

## חן, חוקרת הרשת (flow עצמאי)
מביאה **מקורות אמיתיים ומעודכנים מהרשת** כקלט ל-flow של יעל. יש לה **זיכרון חיפושים**.

| סוכן | קובץ | קלט | פלט |
|------|------|-----|-----|
| **חן** (chen) | `.claude/agents/chen.md` | נושא / מילות מפתח | `content/<YYYY-MM-DD>-<slug>.md` (קישור למקור בראש) |

- זיכרון: `chen/Memory/searches.md`. חן בודקת אותו לפני כל חיפוש ומוסיפה רשומה אחריו.
- כלים: WebSearch, WebFetch, Read, Write, Edit, Glob, Grep. ללא Bash.
- חן לא קוראת ליעל. היא מניחה קובץ ב-`content/` ומדווחת. המנהל מחליט מה הלאה.
- **מילות הפעלה:** חפש, מצא, מחקר, מאמר על, חדש על, מקור על / search, find, research, latest on

### תוכן מהאינטרנט (`/create-article <נושא> [עם תמונות]`)
א. חן מוצאת מקור. ב. אם התבקש שכתוב: יעל על הקובץ. ג. אם יעל ביקשה תמונות: יובל. ד. המנהל משלב ושומר ב-`Output/`. בקשה של "מצא לי מאמר" בלבד נעצרת אחרי חן.

---

# צוות הלקוחות (עבודה מול לקוחות)

| סוכן | קובץ | קלט | פלט | כלים |
|---|---|---|---|---|
| מאפיין לקוח | `.claude/agents/client-intake.md` | תיאור חופשי | `workspace/clients/<slug>/intake.md` | Read, Write, Glob |
| מתכנן בוטים | `.claude/agents/bot-designer.md` | intake | `workspace/clients/<slug>/bot-flow.md` | Read, Write, Glob |
| מתכנן אתרים | `.claude/agents/site-planner.md` | intake | `workspace/clients/<slug>/site-plan.md` | Read, Write, Glob |
| הצעות מחיר | `.claude/agents/proposal-writer.md` | intake + תוכניות | `workspace/clients/<slug>/proposal.md` | Read, Write, Glob |

**לקוח חדש:** `/new-client <תיאור>`. אפיון, ואז בוט ו/או אתר, ואז הצעת מחיר.
**מילות הפעלה:** לקוח חדש, ליד, אפיון / בוט, וואטסאפ, טלגרם, זרימת שיחה / אתר, דף נחיתה / הצעת מחיר, תמחור.

---

## מבנה התיקיות
```
.claude/
  agents/      ← orchestrator, researcher, writer, editor, publisher, chen, yael, yuval + סוכני הלקוחות
  commands/    ← create-content, create-article, new-client, new-agent
  skills/      ← gpt-image-gen, design-taste-frontend-v1
content/       ← מאמרי גלם (פלט חן, קלט יעל) + תיקיות השרשרת:
  briefs/ research/ drafts/ final/   brief-template.md
Output/        ← תוצרים סופיים של יעל (MD + HTML + תמונות משובצות)
chen/Memory/   ← searches.md
yael/          ← style-guide.md, reference/
yuval/         ← reference/, outputs/
workspace/clients/  ← תיקיית לקוח לכל slug (לא ב-git)
business/      ← pricing.md
templates/     ← agent.md
docs/          ← decisions.md
```

## חוקי ברזל
- לעולם לא מעלים `.env` או מפתחות API ל-git. משתמשים ב-`.env.example` כתבנית.
- לא ממציאים מקורות. אין מקור? אומרים זאת.
- פעולה שיוצאת החוצה (פרסום, שליחת מייל, תשלום) דורשת אישור מפורש של המשתמש.
- **לא ממציאים מחירים.** המחירון ב-`business/pricing.md`. ריק? ההצעה מסמנת `[למלא]`.
- **מידע על לקוחות הוא פרטי.** נשאר ב-`workspace/clients/` (לא ב-git) ולא נשלח לשירות חיצוני בלי אישור.
- **תמונות עולות כסף.** תמונה אחת לכל placeholder, בלי וריאציות. מעל 3 תמונות, מאשרים עם המשתמש.
- בקליניקות ובתחומי בריאות ואסתטיקה: לא מייצרים תמונות "לפני/אחרי" ולא מבטיחים תוצאות.
- בוטים של וואטסאפ: מכבדים את מדיניות Meta (הסכמה, תבניות מאושרות מחוץ לחלון 24 שעות).
- למשימות מורכבות או שינויים גדולים: plan mode לפני ביצוע.
- החלטות ארכיטקטורה נרשמות ב-`docs/decisions.md`, שורה אחת עם תאריך.
- כשמוסיפים סוכן, מוסיפים אותו לטבלה המתאימה כאן.
