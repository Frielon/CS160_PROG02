// Test whether the checker call (js/checker.js) catches misreadings.
//
//   node tools/eval-checker.mjs --tag c1
//   node tools/eval-checker.mjs --models google/gemini-2.5-flash-lite,google/gemini-2.5-flash --runs 2 --tag c1-compare
//   node tools/eval-checker.mjs --cases P40-real-everyday,N40-whole --tag quick
//
// Cases live in tools/checker-cases.json: real misreadings from testing, errors planted into correct
// texts, and correct texts. An error counts as caught when the checker flags a claim that matches it.
// Results go to tools/.cache/eval/<tag>.{json,md}.

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
const C = vm.runInContext('({ CHECK_MODEL, VERIFY_MODEL, CHECK_PROMPT_VERSION, checkClaims })', ctx);

const allCases = JSON.parse(readFileSync(join(ROOT, 'tools/checker-cases.json'), 'utf8')).cases;
const cases = args.cases ? allCases.filter((c) => args.cases.split(',').includes(c.id)) : allCases;
// --models sets the verifier (call B); --meaning-model sets call A (default CHECK_MODEL).
const models = (args.models || C.VERIFY_MODEL).split(',');
const runs = Number(args.runs || 1);
const tag = args.tag || `${C.CHECK_PROMPT_VERSION}-${Date.now()}`;
const concurrency = Number(args.concurrency || 4);

const key = process.env.OPENROUTER_API_KEY
  || (readFileSync(join(ROOT, 'js/config.local.js'), 'utf8').match(/OPENROUTER_API_KEY\s*=\s*['"]([^'"]+)/) || [])[1];
if (!key || key.startsWith('YOUR_')) { console.error('No API key'); process.exit(1); }

async function send(messages, { model, maxTokens, temperature, responseFormat }) {
  for (let tries = 1; ; tries++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
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

const jobs = [];
for (const model of models) for (const c of cases) for (let run = 1; run <= runs; run++) jobs.push({ model, c, run });

async function runJob({ model, c, run }) {
  const measure = pack.measures.find((m) => m.id === c.measure);
  try {
    const r = await C.checkClaims(measure, c.text, send, { verifyModel: model, model: args['meaning-model'] || C.CHECK_MODEL });
    const errors = c.errors.map((e) => {
      const re = new RegExp(e.match, 'i');
      const hit = r.flagged.find((f) => re.test(f.claim));
      return { what: e.what, caught: Boolean(hit), verdict: hit?.verdict, quoteFound: hit?.quoteFound, reason: hit?.reason };
    });
    const other = r.flagged.filter((f) => !c.errors.some((e) => new RegExp(e.match, 'i').test(f.claim)));
    return { model, id: c.id, kind: c.kind, run, errors, other, claims: r.claims, cost: r.cost, ms: r.ms,
      reasoningTokens: r.calls.reduce((n, d) => n + (d.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0) };
  } catch (err) {
    return { model, id: c.id, kind: c.kind, run, error: err.message };
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const r = await runJob(jobs[next++]);
    results.push(r);
    process.stdout.write(r.error ? 'x' : '.');
  }
}
console.log(`${tag}: ${jobs.length} checks (${cases.length} cases × ${models.length} model(s) × ${runs} run(s))`);
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
console.log('\n');

const pad = (s, n) => String(s).padEnd(n);
for (const model of models) {
  const rows = results.filter((r) => r.model === model);
  console.log(`== ${model}`);
  for (const c of cases) for (const r of rows.filter((x) => x.id === c.id).sort((a, b) => a.run - b.run)) {
    if (r.error) { console.log(' ', pad(r.id, 20), 'ERROR', r.error); continue; }
    const caught = r.errors.map((e) => (e.caught ? `✓ ${e.verdict} (quote ${e.quoteFound})` : `✗ missed: ${e.what}`)).join('; ');
    console.log(' ', pad(r.id, 20), pad(r.kind, 9), pad(`${r.claims.length} claims`, 10), pad(caught || '—', 46),
      r.other.length ? `other flags: ${r.other.length}` : '', `  $${r.cost.toFixed(4)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  const ok = rows.filter((r) => !r.error);
  const errs = (kind) => ok.filter((r) => r.kind === kind).flatMap((r) => r.errors);
  const rate = (xs) => `${xs.filter((e) => e.caught).length}/${xs.length}`;
  const claims = ok.flatMap((r) => r.claims.flatMap((c) => c.facts || [c]));
  const q = (k) => claims.filter((c) => c.quoteFound === k).length;
  const neg = ok.filter((r) => r.kind === 'negative');
  console.log(`  caught: real ${rate(errs('real'))} · planted ${rate(errs('planted'))}`
    + ` · correct texts with a flag: ${neg.filter((r) => r.other.length).length}/${neg.length} (${neg.reduce((n, r) => n + r.other.length, 0)} flags)`
    + ` · other flags on error texts: ${ok.filter((r) => r.kind !== 'negative').reduce((n, r) => n + r.other.length, 0)}`);
  console.log(`  quotes: ${q('exact')} exact, ${q('partial')} partial, ${q('missing')} not in the text, ${q('none')} empty (of ${claims.length} checked facts)`
    + ` · cost $${ok.reduce((n, r) => n + r.cost, 0).toFixed(4)} · mean ${(ok.reduce((n, r) => n + r.ms, 0) / ok.length / 1000).toFixed(1)}s per check`
    + ` · ${rows.length - ok.length} errors\n`);
}

const outDir = join(ROOT, 'tools/.cache/eval');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, checkPrompt: C.CHECK_PROMPT_VERSION, results }, null, 2));
writeFileSync(join(outDir, `${tag}.md`), results.filter((r) => !r.error).map((r) =>
  `## ${r.model} · ${r.id} (${r.kind}) · run ${r.run}\n\n`
  + r.claims.map((c) => `- **${c.verdict}**: ${c.claim}\n` + (c.facts || []).map((f) => `  - [${f.verdict}, quote ${f.quoteFound}] ${f.fact}\n    - quote: ${f.quote}\n    - reason: ${f.reason}`).join('\n')).join('\n')).join('\n\n'));
console.log(`Saved tools/.cache/eval/${tag}.json and .md`);
