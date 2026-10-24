// טוען את הגדרות הסוכנים מקבצי agents/*.md (front matter, גוף, ורשימת הצעדים).
const fs = require('fs');
const path = require('path');

const IDS = ['orchestrator', 'chen', 'researcher', 'writer', 'yael', 'yuval', 'editor', 'publisher'];

function parseAgent(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const fm = {};
  (m ? m[1] : '').split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  const body = (m ? m[2] : raw).trim();
  const sec = /\n## (?:מה לעשות|Flow|Workflow)[^\n]*\n([\s\S]*?)(?:\n## |$)/.exec('\n' + body);
  const clean = s => s.replace(/\*\*|`/g, '').trim();
  const steps = sec ? sec[1].split('\n').map(l => /^\d+\.\s+(.*)$/.exec(l.trim())).filter(Boolean).map(x => clean(x[1])) : [];
  return { description: fm.description || '', tools: (fm.tools || '').split(',').map(s => s.trim()).filter(Boolean), body, steps };
}

function loadAgentsData(dir) {
  const out = {};
  const skillsDir = path.join(dir, '..', 'skills'), rd = f => { try { return fs.readFileSync(path.join(skillsDir, f), 'utf8').replace(/\r\n/g, '\n').trim(); } catch { return ''; } };
  for (const id of IDS) { out[id] = parseAgent(path.join(dir, id + '.md')); out[id].skills = rd(id + '.md'); }
  out._regulated = rd('_regulated.md');
  return out;
}

module.exports = { loadAgentsData };
