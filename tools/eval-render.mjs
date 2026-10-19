// Test the reading-level × length prompts against the real API.
//
//   node tools/eval-render.mjs --measures prop-4,prop-43 --tag v1
//   node tools/eval-render.mjs --measures all --lengths short,standard --runs 2 --tag v2-check
//   node tools/eval-render.mjs --measures all --revise --tag v3   (one measured retry when a draft misses)
//   node tools/eval-render.mjs --measures prop-40 --revise --fact-check --final-fix --tag fc   (the guide's full pipeline)
//   node tools/eval-render.mjs --dry            (show prompt sizes, no API calls, free)
//
// It loads js/fk.js and js/prompts.js exactly as the browser does, so it tests the prompts the guide sends.
// The key comes from $OPENROUTER_API_KEY or js/config.local.js. Results go to tools/.cache/eval/<tag>.{json,md}.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 1. Options ------------------------------------------------------------------
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));

const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
for (const file of ['js/fk.js', 'js/prompts.js', 'js/checker.js']) vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), ctx, { filename: file });
const P = vm.runInContext(`({ PROMPT_VERSION, RENDER_TEMPERATURE, buildRenderMessages, sourceTooShort, renderMeasure,
  levelById, lengthById, checkClaims, fixRendering })`, ctx);

const pick = (value, all) => (value === 'all' || !value ? all : value.split(','));
const measures = pick(args.measures === undefined ? 'prop-4,prop-43' : args.measures, pack.measures.map((m) => m.id))
  .map((id) => pack.measures.find((m) => m.id === id) || die(`no measure ${id}`));
const levels = pick(args.levels, ['plain', 'everyday', 'simplest']);
const lengths = pick(args.lengths, ['headline', 'short', 'standard', 'complete']);
const runs = Number(args.runs || 1);
const tag = args.tag || `${P.PROMPT_VERSION}-${Date.now()}`;
const concurrency = Number(args.concurrency || 4);
const temperature = args.temperature !== undefined ? Number(args.temperature) : undefined; // undefined = the guide's RENDER_TEMPERATURE
const reasoning = args.reasoning ? Number(args.reasoning) : 0; // thinking-token budget; 0 = off (the model's default)
// --render-model swaps the model that writes the rendering (the checks keep their own models).
// Gemini 2.5 Flash thinks by default and its thinking counts against max_tokens, so it gets headroom.
const renderModel = args['render-model'] || 'google/gemini-2.5-flash-lite';
const renderHeadroom = renderModel.includes('flash-lite') ? 0 : 8000;

function die(msg) { console.error(msg); process.exit(1); }

const jobs = [];
for (const m of measures) for (const lv of levels) for (const ln of lengths) for (let r = 1; r <= runs; r++) {
  jobs.push({ measure: m, level: lv, length: ln, run: r });
}

if (args.dry) {
  for (const m of measures) {
    const msgs = P.buildRenderMessages(m, 'everyday', 'short');
    const chars = msgs.reduce((n, x) => n + x.content.length, 0);
    console.log(`${m.label}: ~${Math.round(chars / 4)} input tokens per call`);
  }
  console.log(`${jobs.length} calls planned. Example prompt (Prop 4, everyday, short), legal text cut:\n`);
  const [sys, user] = P.buildRenderMessages(measures[0], 'everyday', 'short');
  console.log('SYSTEM:\n' + sys.content + '\n\nUSER:\n' + user.content.replace(/<legal_text>[\s\S]*<\/legal_text>/, '<legal_text>…</legal_text>'));
  process.exit(0);
}

// ---- 2. Call the API -------------------------------------------------------------
const key = process.env.OPENROUTER_API_KEY
  || (readFileSync(join(ROOT, 'js/config.local.js'), 'utf8').match(/OPENROUTER_API_KEY\s*=\s*['"]([^'"]+)/) || [])[1];
if (!key || key.startsWith('YOUR_')) die('No API key: set OPENROUTER_API_KEY or create js/config.local.js');

/** OpenRouter call with the same body the guide sends. Retries network errors twice. */
async function send(messages, { maxTokens, temperature: t, model, responseFormat }) {
  const thinking = reasoning && !responseFormat; // the thinking budget is for rendering calls only
  for (let tries = 1; ; tries++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: model || renderModel, messages,
          temperature: responseFormat ? t : temperature ?? t,
          max_tokens: maxTokens + (thinking ? reasoning : 0) + (model ? 0 : renderHeadroom),
          response_format: responseFormat,
          ...(thinking ? { reasoning: { max_tokens: reasoning, exclude: true } } : {}),
        }),
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

/** The numbers we keep from one call (the pipeline also returns the messages and raw reply). */
function summarize(r) {
  const u = r.data.usage || {};
  return {
    text: r.text, words: r.words, grade: r.grade, sentences: r.sentences, syllables: r.syllables,
    lengthOk: r.lengthOk, gradeOk: r.gradeOk, missing: r.missing, misread: r.misread, finish: r.finish,
    cost: r.cost + (r.fixedFrom ? 0 : r.factCheck?.cost || 0), ms: r.ms + (r.fixedFrom ? 0 : r.factCheck?.ms || 0),
    flagged: r.factCheck ? r.factCheck.flagged.map((f) => ({ claim: f.claim, verdict: f.verdict, reason: f.reason, quoteFound: f.quoteFound })) : null,
    promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

async function runJob(job) {
  const base = { measure: job.measure.id, level: job.level, length: job.length, run: job.run,
    shortSource: P.sourceTooShort(job.measure, job.length) };
  try {
    const factCheck = args['fact-check'] ? (text) => P.checkClaims(job.measure, text, send) : null;
    const lv = P.levelById(job.level);
    const finalFix = args['final-fix'] ? (text, fc) => P.fixRendering(job.measure, `${lv.label} (${lv.target})`, text, fc, send,
      { wordRange: P.lengthById(job.length).words }) : null;
    const r = await P.renderMeasure(job.measure, job.level, job.length, send, () => {}, { revise: Boolean(args.revise), factCheck, finalFix });
    const parts = [r.draft, r.revision].filter(Boolean);
    const cost = parts.reduce((n, x) => n + x.cost + (x.factCheck?.cost || 0), 0) + (r.kept.fix?.cost || 0);
    const ms = parts.reduce((n, x) => n + x.ms + (x.factCheck?.ms || 0), 0) + (r.kept.fix?.ms || 0);
    const fix = r.kept.fix && {
      flagsBefore: (r.kept.fixedFrom || r.kept).factCheck ? (r.kept.fixedFrom?.factCheck || r.kept.factCheck).flagged.length : 0,
      used: Boolean(r.kept.fixedFrom), rejected: Boolean(r.kept.fixRejected),
      edits: r.kept.fix.edits.map((e) => ({ original: e.original, replacement: e.replacement, accepted: e.accepted, note: e.note })),
      disputed: r.kept.fix.disputed,
    };
    const shown = { ...summarize(r.kept), cost, ms, fix };
    if (!r.revision) return { ...base, ...shown };
    return { ...base, ...shown, draft: summarize(r.draft), revision: summarize(r.revision), keptRevision: r.keptRevision };
  } catch (err) {
    return { ...base, error: err.message };
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await runJob(job);
    results.push(r);
    process.stdout.write(r.error ? 'x' : '.');
  }
}
console.log(`${tag}: ${jobs.length} renderings by ${renderModel}, temperature ${temperature ?? P.RENDER_TEMPERATURE}${reasoning ? `, thinking budget ${reasoning}` : ''}`);
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
console.log('\n');

// ---- 3. Report ---------------------------------------------------------------------
const order = (r) => [measures.findIndex((m) => m.id === r.measure), levels.indexOf(r.level), lengths.indexOf(r.length), r.run];
results.sort((a, b) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });

const mark = (ok) => (ok == null ? ' ' : ok ? '✓' : '✗');
// '~' = under the range only because the legal text itself is too short to fill it.
const lengthMark = (r) => (!r.lengthOk && r.shortSource && r.words < P.lengthById(r.length).words[0] ? '~' : mark(r.lengthOk));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(pad('measure', 8), pad('level', 9), pad('length', 9), lpad('words', 6), ' ', lpad('grade', 5), '  ', pad('target', 22), pad('revised from', 24), 'missing facts');
for (const r of results) {
  if (r.error) { console.log(pad(r.measure, 8), pad(r.level, 9), pad(r.length, 9), 'ERROR', r.error); continue; }
  const lv = P.levelById(r.level), ln = P.lengthById(r.length);
  console.log(pad(r.measure, 8), pad(r.level, 9), pad(r.length, 9), lpad(r.words, 6), lengthMark(r), lpad(r.grade, 5), mark(r.gradeOk),
    ' ', pad(`${ln.words ? ln.words.join('–') : 'any'} w, gr ${lv.grade.join('–')}`, 22),
    r.draft ? pad(r.keptRevision ? `(draft ${r.draft.words}w gr ${r.draft.grade})` : `(kept draft; rev ${r.revision.words}w ${r.revision.grade})`, 24) : pad('', 24),
    [...(r.flagged || []).map((f) => `FLAG ${f.verdict}: "${f.claim.slice(0, 50)}…"`), ...r.misread.map((m) => 'MISREAD: ' + m.wrong), ...r.missing].join('; ') || '', r.finish !== 'stop' ? `[finish: ${r.finish}]` : '');
}

const ok = results.filter((r) => !r.error);
const firstPass = ok.map((r) => ({ ...r, ...(r.draft || {}) }));
const revised = ok.filter((r) => r.draft);
const rate = (rows, key) => { const xs = rows.filter((r) => r[key] != null); return xs.length ? `${xs.filter((r) => r[key]).length}/${xs.length}` : '—'; };
console.log('\nBy level:');
for (const lv of levels) {
  const rows = ok.filter((r) => r.level === lv);
  const grades = rows.map((r) => r.grade);
  const before = args.revise ? ` (first try ${rate(firstPass.filter((r) => r.level === lv), 'gradeOk')})` : '';
  console.log(`  ${pad(lv, 9)} grade in range ${rate(rows, 'gradeOk')}${before}  ·  grades ${Math.min(...grades)}–${Math.max(...grades)}, mean ${(grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(1)}`);
}
console.log('By length:');
for (const ln of lengths) {
  const rows = ok.filter((r) => r.length === ln);
  const words = rows.map((r) => r.words);
  const before = args.revise ? ` (first try ${rate(firstPass.filter((r) => r.length === ln), 'lengthOk')})` : '';
  console.log(`  ${pad(ln, 9)} words in range ${rate(rows, 'lengthOk')}${before}  ·  words ${Math.min(...words)}–${Math.max(...words)}  ·  facts dropped ${rows.filter((r) => r.missing.length).length}/${rows.length}  ·  misreadings ${rows.filter((r) => r.misread.length).length}`);
}
const cost = ok.reduce((n, r) => n + (r.cost || 0), 0);
const slowest = ok.reduce((a, b) => (b.ms > a.ms ? b : a), ok[0]);
if (args['fact-check']) {
  const drafts = ok.map((r) => r.draft || r);
  const beforeFix = ok.map((r) => r.fix?.used ? { flagged: { length: r.fix.flagsBefore } } : r);
  console.log(`Fact check: drafts with a flag ${drafts.filter((d) => d.flagged?.length).length}/${ok.length}`
    + ` · before the final fix ${beforeFix.filter((r) => r.flagged?.length).length}/${ok.length}`
    + ` · shown versions with a flag ${ok.filter((r) => r.flagged?.length).length}/${ok.length}`
    + ` · known misreadings in drafts ${drafts.filter((d) => d.misread.length).length}, in shown versions ${ok.filter((r) => r.misread.length).length}`);
  if (args['final-fix']) {
    const fixes = ok.filter((r) => r.fix);
    const edits = fixes.flatMap((r) => r.fix.edits);
    console.log(`Final fix: ran on ${fixes.length}, used on ${fixes.filter((r) => r.fix.used).length}, rejected by score on ${fixes.filter((r) => r.fix.rejected).length}`
      + ` · edits kept ${edits.filter((e) => e.accepted).length}/${edits.length} · disputed flags ${fixes.reduce((n, r) => n + r.fix.disputed.length, 0)}`);
  }
}
const cached = ok.reduce((n, r) => n + r.cachedTokens, 0);
const thought = ok.reduce((n, r) => n + (r.reasoningTokens || 0) + (r.draft?.reasoningTokens || 0), 0);
console.log(`\nCost $${cost.toFixed(4)} for ${ok.length} renderings, ${revised.length} sent back for revision, ${revised.filter((r) => r.keptRevision).length} revisions kept (${results.length - ok.length} errors) · cached input tokens ${cached}${thought ? ` · thinking tokens ${thought}` : ''}`
  + ` · slowest ${(slowest?.ms / 1000).toFixed(1)}s (${slowest?.measure} ${slowest?.level} ${slowest?.length})`);

const outDir = join(ROOT, 'tools/.cache/eval');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, promptVersion: P.PROMPT_VERSION, temperature: temperature ?? P.RENDER_TEMPERATURE, reasoning, results }, null, 2));
writeFileSync(join(outDir, `${tag}.md`), results.map((r) => r.error ? `## ${r.measure} · ${r.level} · ${r.length} · run ${r.run}\n\nERROR ${r.error}\n`
  : `## ${r.measure} · ${r.level} · ${r.length} · run ${r.run}\n\n${r.words} words ${lengthMark(r)} · grade ${r.grade} ${mark(r.gradeOk)} · $${r.cost} · ${(r.ms / 1000).toFixed(1)}s`
    + `${r.missing.length ? ` · missing: ${r.missing.join('; ')}` : ''}\n\n${r.text}\n`
    + (r.draft ? `\n> ${r.keptRevision ? 'First draft' : 'Revision (not kept)'} (${(r.keptRevision ? r.draft : r.revision).words} words, grade ${(r.keptRevision ? r.draft : r.revision).grade}):\n> ${(r.keptRevision ? r.draft : r.revision).text.replace(/\n/g, '\n> ')}\n` : '')
    + (r.fix ? `\nFinal fix (${r.fix.used ? 'used' : r.fix.rejected ? 'not used: scored worse' : 'no edit kept'}):\n`
      + r.fix.edits.map((e) => `- ${e.accepted ? 'kept' : 'dropped'}${e.note ? ` (${e.note})` : ''}: "${e.original}" → "${e.replacement || '(deleted)'}"`).join('\n') + '\n' : '')).join('\n'));
console.log(`Saved tools/.cache/eval/${tag}.json and .md`);
