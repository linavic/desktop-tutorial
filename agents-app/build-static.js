// בונה גרסה סטטית להעלאה לכל אירוח אתרים (בלי Node בשרת): node build-static.js [תיקיית יעד]
// הדפדפן מדבר ישירות עם OpenAI. המפתח מוזן בדף ונשאר בדפדפן של המשתמש.
const fs = require('fs');
const path = require('path');
const { loadAgentsData } = require('./lib/agents.js');

const out = path.resolve(process.argv[2] || path.join(__dirname, 'dist'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'crew-engine.js']) fs.copyFileSync(path.join(__dirname, 'public', f), path.join(out, f));
fs.writeFileSync(path.join(out, 'agents.json'), JSON.stringify(loadAgentsData(path.join(__dirname, 'agents'))));
fs.copyFileSync(path.join(__dirname, 'profiles.json'), path.join(out, 'profiles.json'));
let defaultContext = '';
try { defaultContext = fs.readFileSync(process.env.CONTEXT_FILE || path.join(__dirname, 'context.md'), 'utf8'); } catch { /* optional */ }
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({ brand: process.env.BRAND_NAME || 'Agent Crew', base: process.env.OPENAI_BASE_URL || 'https://api.openai.com', defaultContext, ...(process.env.API_BASE ? { apiBase: process.env.API_BASE } : {}) }));
fs.writeFileSync(path.join(out, 'htaccess.example.txt'), `# אופציונלי: הגנה בסיסמה ברמת האירוח (Apache). לשנות את השם ל-.htaccess ולהוסיף קובץ .htpasswd
# (אפשר ליצור בלוח הבקרה של האירוח: "Password Protect Directories", או בכלי htpasswd).
AuthType Basic
AuthName "Agent Crew"
AuthUserFile /נתיב/מלא/אל/.htpasswd
Require valid-user
`);
console.log('נבנה ב:', out, '\nמעלים את כל הקבצים בתיקייה (לא את התיקייה עצמה) לתיקייה באתר, למשל /crew/');
