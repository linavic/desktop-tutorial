# מערכת הסוכנים שלי

Claude קורא את הקובץ הזה בתחילת כל סשן. הוא "המוח" של המערכת: מי הצוות, איך מנתבים משימות, ואיך סוכנים מעבירים עבודה זה לזה.

## הקשר
- **העסק:** סוכנות/פרילנס דיגיטלית לעסקים. שלושה שירותים: (1) אוטומציות לעסקים, (2) בוטים בוואטסאפ ובטלגרם (כולל בוטי AI), (3) עיצוב ובניית אתרים. בנוסף, צוות תוכן (https://as-biz.com/crew) שמפיק פוסטים לעסקים.
- **קהל יעד:** בעלי עסקים קטנים ובינוניים בישראל שמבזבזים זמן על עבודה ידנית (מענה ללקוחות, תיאום, לידים) ורוצים אתר או בוט שמביאים לקוחות. לא טכניים.
- **קול ומותג:** <למלא. ברירת מחדל מוצעת: מקצועי, ישיר וחם, בלי ז'רגון טכני מיותר, עברית בגובה העיניים>
- **מה הלקוח באמת קונה:** חיסכון בזמן, פחות לידים שנופלים, מענה מהיר 24/7. מדברים בתוצאה, לא בכלים.
- **שפה:** עברית כברירת מחדל. אנגלית כשהפרויקט דורש.

## עקרונות הליבה
1. **הסשן הראשי הוא המנהל ("ראובן").** סוכן־משנה לא יכול להפעיל סוכן אחר, ולכן הסשן הראשי מפעיל את הסוכנים לפי הסדר ומעביר ביניהם נתיבי קבצים.
2. **העברה דרך קבצים.** כל סוכן קורא קובץ ומשאיר קובץ. אין זיכרון משותף. כך אפשר לבדוק, לתקן ולהריץ מחדש כל שלב.
3. **סוכן אחד, תפקיד אחד, כלים מינימליים.** רק חן מקבלת גישה לרשת. רק יובל מקבל Bash.
4. **מעקב בקובץ.** לכל הרצה יש `content/status/<slug>.md` שמראה באיזה שלב היא נמצאת. לא מדווחים על התקדמות בצ'אט.
5. **הרצה בחזית, תוצאה בסוף.** מציגים למשתמש את התוצר ומה נשאר פתוח, לא את מה שרץ בדרך.
6. **סגנון עקבי.** יעל קוראת `yael/style-guide.md` ו-`yael/reference/`. יובל קורא `yuval/reference/`.

---

# צוות התוכן: שרשרת אחת של 8 סוכנים
תואם את הצוות באתר https://as-biz.com/crew. הפעלה: `/create-content <נושא> [עם תמונות]`.

```
בקשה → מנהל תוכן → חוקר הרשת → חוקר תוכן → קופירייטר → עורך הסגנון → מעצב ויזואלי → עורך ראשי → מנהל הפצה
          brief       sources      research      drafts       styled         images          final       distribution
```

| # | תפקיד | סוכן | קובץ | קלט | פלט |
|---|---|---|---|---|---|
| 1 | מנהל תוכן | orchestrator | `.claude/agents/orchestrator.md` | בקשה | `content/briefs/<slug>.md` |
| 2 | חוקר הרשת | חן (chen) | `.claude/agents/chen.md` | בריף | `content/sources/<slug>.md` |
| 3 | חוקר תוכן | researcher | `.claude/agents/researcher.md` | בריף + מקורות | `content/research/<slug>.md` |
| 4 | קופירייטר | writer | `.claude/agents/writer.md` | בריף + מחקר | `content/drafts/<slug>.md` |
| 5 | עורך הסגנון | יעל (yael) | `.claude/agents/yael.md` | טיוטה + מדריך סגנון | `content/styled/<slug>.md` |
| 6 | מעצב ויזואלי | יובל (yuval) | `.claude/agents/yuval.md` | placeholders + בריף | `yuval/outputs/<slug>-<n>.png` + `content/images/<slug>.md` |
| 7 | עורך ראשי | editor | `.claude/agents/editor.md` | טקסט + תמונות + מחקר | `content/final/<slug>.md` + `Output/<slug>.html` |
| 8 | מנהל הפצה | publisher | `.claude/agents/publisher.md` | גרסה סופית | `content/final/<slug>.distribution.md` |

- **כלים:** רק חן עם WebSearch/WebFetch. רק יובל עם Bash (לסקיל `gpt-image-gen`, דורש `OPENAI_API_KEY`, המודל ב-`IMAGE_MODEL`). השאר Read, Write, Glob (והעורכים גם Grep).
- **תמונות:** הבריף קובע אם יש ומה הפורמט של הרשת. אין תמונות? שלב 6 מדולג. יעל מסמנת `{{IMAGE_NEEDED: "..."}}`, יובל מייצר תמונה אחת לכל placeholder, והעורך הראשי משלב.
- **זיכרון:** חן מתעדת חיפושים ב-`chen/Memory/searches.md` ובודקת אותו לפני כל חיפוש.
- **עצירה מוקדמת:** "מצא לי מאמר" בלבד נעצר אחרי שלב 2.
- **מאמר מוכן מהמשתמש:** נשמר ב-`content/sources/<slug>.md`, שלבים 2-4 מדולגים ויעל משכתבת אותו.

**מילות הפעלה:** חפש, מצא, מחקר, מאמר על, חדש על / שכתב, ערוך, נסח מחדש, תרגם, סכם, פוסט / תמונה של, איור / search, find, rewrite, post, image of.

---

# צוות הלקוחות (עבודה מול לקוחות)

| סוכן | קובץ | קלט | פלט | כלים |
|---|---|---|---|---|
| מאפיין לקוח | `.claude/agents/client-intake.md` | תיאור חופשי | `workspace/clients/<slug>/intake.md` | Read, Write, Glob |
| מתכנן בוטים | `.claude/agents/bot-designer.md` | intake | `workspace/clients/<slug>/bot-flow.md` | Read, Write, Glob |
| מתכנן אתרים | `.claude/agents/site-planner.md` | intake | `workspace/clients/<slug>/site-plan.md` | Read, Write, Glob |
| הצעות מחיר | `.claude/agents/proposal-writer.md` | intake + תוכניות | `workspace/clients/<slug>/proposal.md` | Read, Write, Glob |

**לקוח חדש:** `/new-client <תיאור>`. אפיון, ואז בוט ו/או אתר במקביל, ואז הצעת מחיר.
**מילות הפעלה:** לקוח חדש, ליד, אפיון / בוט, וואטסאפ, טלגרם, זרימת שיחה / אתר, דף נחיתה / הצעת מחיר, תמחור.

---

## מבנה התיקיות
```
.claude/
  agents/      ← 8 סוכני התוכן + 4 סוכני הלקוחות
  commands/    ← create-content, new-client, new-agent
  skills/      ← gpt-image-gen, design-taste-frontend-v1
content/       ← briefs/ sources/ research/ drafts/ styled/ images/ final/ status/   brief-template.md
Output/        ← קובצי HTML סופיים
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
