// Test the final fix (fixFlagged in js/checker.js) on what the fact check flagged in a saved run.
//
//   node tools/eval-fix.mjs --from c7-flashA-flashB --tag f1
//
// Input: a tools/eval-checker.mjs result (its flagged claims) and tools/checker-cases.json (texts and
// labeled errors). A labeled error counts as fixed when an accepted edit replaced or removed the
// sentence that held it. Every edit is printed so a person can judge the replacements.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(ROOT, 'js/checker.js'), 'utf8'), ctx, { filename: 'js/checker.js' });
const C = vm.runInContext('({ fixFlagged, locate, FIX_MODEL, FIX_PROMPT_VERSION })', ctx);

const source = JSON.parse(readFileSync(join(ROOT, 'tools/.cache/eval', `${args.from || 'c7-flashA-flashB'}.json`), 'utf8')).results;
const cases = JSON.parse(readFileSync(join(ROOT, 'tools/checker-cases.json'), 'utf8')).cases;
const tag = args.tag || `${C.FIX_PROMPT_VERSION}-${Date.now()}`;
const fixModel = args.model || C.FIX_MODEL;
const key = process.env.OPENROUTER_API_KEY
  || (readFileSync(join(ROOT, 'js/config.local.js'), 'utf8').match(/OPENROUTER_API_KEY\s*=\s*['"]([^'"]+)/) || [])[1];

async function send(messages, { model, maxTokens, temperature, responseFormat }) {
  for (let tries = 1; ; tries++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, response_format: responseFormat }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error?.message || response.statusText);
      return data;
    } catch (err) {
      if (tries >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * tries));
    }
  }
}

const jobs = source.filter((r) => !r.error && r.claims.some((c) => c.verdict !== 'supported'));
console.log(`${tag}: fixing ${jobs.length} texts with flags (fixer ${fixModel})`);
const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const src = jobs[next++];
    const c = cases.find((x) => x.id === src.id);
    const measure = pack.measures.find((m) => m.id === c.measure);
    const flagged = src.claims.filter((x) => x.verdict !== 'supported');
    try {
      const wordRange = { headline: [1, 25], short: [75, 100], standard: [250, 300] }[c.length] || null;
      const fix = await C.fixFlagged(measure, '', c.text, flagged, send, { model: fixModel, wordRange });
      const errors = c.errors.map((e) => {
        const re = new RegExp(e.match, 'i');
        const claims = flagged.filter((f) => re.test(f.claim));
        const edit = fix.edits.find((x) => x.accepted && claims.some((f) => C.locate(x.original, f.claim)));
        return { what: e.what, flagged: claims.length > 0, fixed: Boolean(edit), edit };
      });
      results.push({ id: c.id, kind: c.kind, length: c.length, before: c.text, after: fix.text, flagged: flagged.length, edits: fix.edits, disputed: fix.disputed, errors, cost: fix.cost, ms: fix.ms });
      process.stdout.write('.');
    } catch (err) {
      results.push({ id: c.id, error: err.message });
      process.stdout.write('x');
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log('\n');

const words = (t) => t.split(/\s+/).filter(Boolean).length;
for (const r of results.sort((a, b) => a.id.localeCompare(b.id))) {
  if (r.error) { console.log(r.id, 'ERROR', r.error); continue; }
  const acc = r.edits.filter((e) => e.accepted).length;
  console.log(`## ${r.id} (${r.kind}${r.length ? ', ' + r.length : ''}) · ${r.flagged} flags → ${r.edits.length} edits, ${acc} kept, ${r.disputed.length} disputed · words ${words(r.before)} → ${words(r.after)} · $${r.cost.toFixed(4)} ${(r.ms / 1000).toFixed(1)}s`);
  for (const d of r.disputed) console.log(`   ⚖ disputed (left as is): ${d.sentence}`);
  for (const e of r.errors) console.log(`   labeled error: ${e.what} → ${!e.flagged ? 'not flagged by the check' : e.fixed ? 'FIXED' : 'NOT FIXED'}`);
  for (const e of r.edits) {
    console.log(`   ${e.accepted ? '✓ kept' : '✗ dropped'}${e.note ? ` (${e.note})` : ''}`);
    console.log(`      before: ${e.original}`);
    console.log(`      after:  ${e.replacement || '(deleted)'}`);
    if (e.recheck?.some((x) => x.verdict !== 'supported')) console.log(`      re-check: ${e.recheck.filter((x) => x.verdict !== 'supported').map((x) => `${x.verdict}: ${x.reason}`).join(' | ')}`);
  }
}
const ok = results.filter((r) => !r.error);
const errs = ok.flatMap((r) => r.errors).filter((e) => e.flagged);
const edits = ok.flatMap((r) => r.edits);
console.log(`\nLabeled errors fixed: ${errs.filter((e) => e.fixed).length}/${errs.length} (of those the check had flagged)`
  + ` · disputed flags ${ok.reduce((n, r) => n + r.disputed.length, 0)} · edits kept ${edits.filter((e) => e.accepted).length}/${edits.length}, dropped after re-check ${edits.filter((e) => e.note?.startsWith('the replacement was')).length},`
  + ` not found ${edits.filter((e) => e.note === 'could not find the sentence').length}, deletions ${edits.filter((e) => e.accepted && !e.replacement).length}`
  + ` · cost $${ok.reduce((n, r) => n + r.cost, 0).toFixed(4)} · mean ${(ok.reduce((n, r) => n + r.ms, 0) / ok.length / 1000).toFixed(1)}s`);
mkdirSync(join(ROOT, 'tools/.cache/eval'), { recursive: true });
writeFileSync(join(ROOT, 'tools/.cache/eval', `${tag}.json`), JSON.stringify({ tag, fixModel, results }, null, 2));
console.log(`Saved tools/.cache/eval/${tag}.json`);
