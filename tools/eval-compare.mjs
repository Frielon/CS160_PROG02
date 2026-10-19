// Test the two-sides comparison prompt (js/compare.js) against the real API.
//
//   node tools/eval-compare.mjs --measures prop-40 --tag s3-try
//   node tools/eval-compare.mjs --measures all --runs 2 --tag s3
//   node tools/eval-compare.mjs --model google/gemini-2.5-flash-lite --tag s9-lite   (claims call; --backers-model too)
//   node tools/eval-compare.mjs --reasoning 2048 --tag s9-think   (a thinking budget, as in eval-render)
//   node tools/eval-compare.mjs --dry            (show the prompt and its size, no API calls, free)
//
// It loads js/compare.js exactly as the browser does. The key comes from $OPENROUTER_API_KEY or
// js/config.local.js. Results go to tools/.cache/eval/<tag>.{json,md}; the .md is the readable one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));

const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(ROOT, 'js/compare.js'), 'utf8'), ctx, { filename: 'js/compare.js' });
const C = vm.runInContext(`({ COMPARE_PROMPT_VERSION, COMPARE_MODEL, BACKERS_MODEL, COMPARE_DOCS, DIMENSIONS, STATED_AS, CLAIM_STATUS,
  buildCompareMessages, buildBackersMessages, compareSides })`, ctx);

const pick = (value, all) => (value === 'all' || !value ? all : value.split(','));
const measures = pick(args.measures === undefined ? 'prop-40' : args.measures, pack.measures.map((m) => m.id))
  .map((id) => pack.measures.find((m) => m.id === id) || die(`no measure ${id}`));
const runs = Number(args.runs || 1);
const model = args.model || C.COMPARE_MODEL;
const backersModel = args['backers-model'] || C.BACKERS_MODEL;
const tag = args.tag || `${C.COMPARE_PROMPT_VERSION}-${Date.now()}`;
const concurrency = Number(args.concurrency || 4);
const disclaimer = pack.meta.argumentDisclaimer;
const reasoning = args.reasoning ? Number(args.reasoning) : 0; // thinking-token budget; 0 = the model's default

function die(msg) { console.error(msg); process.exit(1); }

// Exchanges a good comparison should find: a YES claim and a NO claim joined by a reply link
// (either rebuttal answering the other side's argument). A word match on each claim's quote and
// restatement (the quote alone missed "block those solutions", which is about housing), so it only
// says the link was made; a person reads the rest.
const EXPECTED = {
  'prop-4': [
    { what: 'limits on candidates and money', yes: /spending limits|strict/i, no: /no limit/i },
    { what: 'does it spend taxpayer money', yes: /single taxpayer dollar|does not create a public financing program|\$1 per resident|simply (?:removes|gives)/i, no: /taxpayer (?:money|funds)/i },
    { what: 'special-interest money', yes: /special interests?|wealthy donors|big money/i, no: /special[- ]interest (?:money|funding)/i },
  ],
  'prop-43': [
    { what: 'the vote threshold', yes: /two-thirds/i, no: /33\.4|one-third|veto/i },
    { what: 'housing', yes: /homeowners|real estate|housing/i, no: /housing|affordable homes/i },
  ],
  'prop-40': [
    { what: '$100 billion raised vs $25 billion lost', yes: /100 billion/i, no: /25 billion/i },
    { what: 'only billionaires vs could reach everyone', yes: /only by californians|cannot be applied to anyone else|billionaire tax/i, no: /all californians|expand|retirement|amend/i },
  ],
  'prop-45': [
    { what: 'environmental protections', yes: /exempt a single project|maintains|comply with all|environmental law/i, no: /ceqa|limits (?:both )?(?:the )?environmental (?:and public )?review|weakens|eliminates/i },
    { what: 'will costs go down', yes: /lower|cost of housing|75,000|electricity/i, no: /lower your (?:costs|rent)/i },
    { what: 'public input', yes: /community input|residents (?:keep|maintain)|keep their voice|public comments/i, no: /public input|right to be heard|public out|public comments/i },
  ],
};
// Groups both sides claim (the handout's Prop 40 example), found by our code from the two backer
// lists. Other measures: we read what it finds.
const EXPECTED_SHARED = {
  'prop-40': [{ what: 'teachers', match: /teacher/i }, { what: 'Planned Parenthood', match: /planned parenthood/i }],
};

const jobs = [];
for (const m of measures) for (let r = 1; r <= runs; r++) jobs.push({ measure: m, run: r });

if (args.dry) {
  const tokens = (msgs) => Math.round(msgs.reduce((n, x) => n + x.content.length, 0) / 4);
  for (const m of measures) {
    console.log(`${m.label}: ~${tokens(C.buildCompareMessages(m, disclaimer))} + ~${tokens(C.buildBackersMessages(m, disclaimer))} input tokens (claims + backers calls)`);
  }
  console.log(`${jobs.length} comparisons planned (2 calls each). The prompts for ${measures[0].label}, documents cut:`);
  const cut = (text) => text.replace(/(<document[^>]*>)\n[\s\S]*?\n<\/document>/g, '$1…</document>');
  for (const [what, build] of [['CLAIMS', C.buildCompareMessages], ['BACKERS', C.buildBackersMessages]]) {
    const [sys, user] = build(measures[0], disclaimer);
    console.log(`\n===== ${what} CALL\nSYSTEM:\n${sys.content}\n\nUSER:\n${cut(user.content)}`);
  }
  process.exit(0);
}

const key = process.env.OPENROUTER_API_KEY
  || (readFileSync(join(ROOT, 'js/config.local.js'), 'utf8').match(/OPENROUTER_API_KEY\s*=\s*['"]([^'"]+)/) || [])[1];
if (!key || key.startsWith('YOUR_')) die('No API key: set OPENROUTER_API_KEY or create js/config.local.js');

/** OpenRouter call with the same body the guide's chat() sends. Retries network errors twice. */
async function send(messages, { model: m, maxTokens, temperature, responseFormat }) {
  for (let tries = 1; ; tries++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: m, messages, max_tokens: maxTokens + reasoning, temperature, response_format: responseFormat,
          ...(reasoning ? { reasoning: { max_tokens: reasoning, exclude: true } } : {}) }),
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

async function runJob({ measure, run }) {
  try {
    const r = await C.compareSides(measure, send, { model, backersModel, disclaimer });
    const byId = new Map(r.claims.map((c) => [c.id, c]));
    const links = r.claims.filter((c) => c.repliesTo).map((c) => [c, byId.get(c.repliesTo)]);
    const expected = (EXPECTED[measure.id] || []).map((e) => {
      const says = (c, re) => re.test(`${c.quote} ${c.restated}`);
      const hit = links.find((pair) => pair.some((c) => c.side === 'yes' && says(c, e.yes)) && pair.some((c) => c.side === 'no' && says(c, e.no)));
      return { what: e.what, ok: Boolean(hit), link: hit && `${hit[0].id} → ${hit[1].id}` };
    });
    const shared = (EXPECTED_SHARED[measure.id] || []).map((e) => ({
      what: e.what,
      ok: Boolean(r.backers?.shared.some((g) => g.yes.some((b) => e.match.test(b.name)) && g.no.some((b) => e.match.test(b.name)))),
    }));
    const usage = (k) => r.calls.reduce((n, d) => n + (d.usage?.[k] ?? 0), 0);
    return { measure: measure.id, label: measure.label, run, claims: r.claims, backers: r.backers, badLinks: r.badLinks,
      summary: r.summary, counts: r.counts, signers: { bothOrgs: r.signers.bothOrgs, bothPeople: r.signers.bothPeople },
      raisedBy: Object.fromEntries(r.dimensions.map((d) => [d.id, d.raisedBy])),
      backersError: r.backersError, expected, shared, cost: r.cost, ms: r.ms, finish: r.finish,
      promptTokens: usage('prompt_tokens'), completionTokens: r.calls.map((d) => d.usage?.completion_tokens ?? 0).join('+'),
      reasoningTokens: r.calls.reduce((n, d) => n + (d.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0),
      raw: r.calls.map((d) => d.choices?.[0]?.message?.content) };
  } catch (err) {
    return { measure: measure.id, label: measure.label, run, error: err.message };
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
console.log(`${tag}: ${jobs.length} comparisons, claims by ${model}, backers by ${backersModel}, prompt ${C.COMPARE_PROMPT_VERSION}${reasoning ? `, thinking budget ${reasoning}` : ''}`);
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
console.log('\n');

// ---- Report ------------------------------------------------------------------------------
results.sort((a, b) => measures.findIndex((m) => m.id === a.measure) - measures.findIndex((m) => m.id === b.measure) || a.run - b.run);
const pad = (s, n) => String(s).padEnd(n);
const STATUS_SHORT = { answered: 'ans', unanswered: 'unans', reply: 'reply', repeat: 'rep', new: 'new' };
console.log(pad('measure', 8), pad('run', 4), pad('claims YA/NA/YR/NR', 19), pad('both-sided dims', 16), pad('ans/unans/reply/rep/new', 24),
  pad('quotes ✓/~/✗', 13), pad('moved', 6), pad('bad links', 10), pad('flags', 6), pad('backers ✓', 10), pad('pairs', 6), 'cost · time · out tokens');
for (const r of results) {
  if (r.error) { console.log(pad(r.measure, 8), pad(r.run, 4), 'ERROR', r.error); continue; }
  const c = r.counts;
  const q = c.quotes;
  console.log(pad(r.measure, 8), pad(r.run, 4), pad(`${c.claims} = ${C.COMPARE_DOCS.map((d) => c.perDocument[d.key]).join('/')}`, 19),
    pad(`${c.dimensionsBoth}/5`, 16), pad(Object.keys(STATUS_SHORT).map((s) => c.status[s]).join('/'), 24),
    pad(`${q.exact}/${q.partial}/${q.missing + q.none}`, 13), pad(c.moved, 6), pad(c.badLinks, 10), pad(c.flagged, 6),
    pad(`${c.backersVerified}/${c.backers.yes + c.backers.no}`, 10), pad(`${r.expected.filter((e) => e.ok).length}/${r.expected.length}`, 6),
    `$${r.cost.toFixed(4)} · ${(r.ms / 1000).toFixed(1)}s · ${r.completionTokens}${r.reasoningTokens ? ` (${r.reasoningTokens} thinking)` : ''}${r.finish !== 'stop' ? ` [finish: ${r.finish}]` : ''}`);
  for (const e of r.expected.filter((x) => !x.ok)) console.log('    missed exchange:', e.what);
  for (const e of r.shared.filter((x) => !x.ok)) console.log('    missed shared group:', e.what);
  if (r.backersError) console.log('    backers call failed:', r.backersError);
  if (r.backers?.shared.length) console.log('    both sides claim:', r.backers.shared.map((g) => `${g.yes.map((b) => b.name).join(' / ')} ↔ ${g.no.map((b) => b.name).join(' / ')}`).join('; '));
  const unchecked = r.backers ? [...r.backers.yes, ...r.backers.no].filter((b) => !b.verified) : [];
  if (unchecked.length) console.log('    backers not verified:', unchecked.map((b) => `${b.name} [${b.quoteFound}${b.key ? '' : ', not on its side'}]`).join('; '));
  if (r.badLinks.length) console.log('    bad links:', r.badLinks.map((l) => `${l.from}→${l.to}`).join(' '));
}
const ok = results.filter((r) => !r.error);
const statusTotals = Object.keys(C.CLAIM_STATUS).map((s) => `${s} ${ok.reduce((n, r) => n + r.counts.status[s], 0)}`).join(' · ');
const exp = ok.flatMap((r) => [...r.expected, ...r.shared]);
console.log(`\nClaim statuses: ${statusTotals}`);
console.log(`Expected exchanges and shared groups found: ${exp.filter((e) => e.ok).length}/${exp.length} · cost $${ok.reduce((n, r) => n + r.cost, 0).toFixed(4)}`
  + ` for ${ok.length} comparisons (${results.length - ok.length} errors) · mean ${(ok.reduce((n, r) => n + r.ms, 0) / Math.max(1, ok.length) / 1000).toFixed(1)}s`);

const outDir = join(ROOT, 'tools/.cache/eval');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, promptVersion: C.COMPARE_PROMPT_VERSION, model, backersModel, reasoning, results }, null, 2));

const claimLine = (c) => `  - **${c.id}** · ${c.round} · ${C.STATED_AS[c.stated_as] || c.stated_as} · _${c.status}_`
  + `${c.repliesTo ? ` → replies to ${c.repliesTo}` : ''}${c.repeatsId ? ` · repeats ${c.repeatsId}` : ''}${c.answeredBy.length ? ` · answered by ${c.answeredBy.join(', ')}` : ''}`
  + `${c.quoteFound !== 'exact' ? ` · quote ${c.quoteFound}` : ''}${c.movedFrom ? ` · MOVED from ${c.movedFrom}` : ''}\n`
  + `    ${c.restated}\n    > ${c.quote}${c.flags.length ? `\n    ⚑ ${c.flags.map((f) => f.text).join(' ')}` : ''}`;
writeFileSync(join(outDir, `${tag}.md`), results.map((r) => {
  if (r.error) return `# ${r.label} · run ${r.run}\n\nERROR ${r.error}\n`;
  return `# ${r.label} · run ${r.run}\n\n$${r.cost.toFixed(4)} · ${(r.ms / 1000).toFixed(1)}s · ${r.counts.claims} claims\n\n`
    + `- ${r.summary.yes}\n- ${r.summary.no}\n\n`
    + `Expected: ${[...r.expected, ...r.shared].map((e) => `${e.ok ? '✓' : '✗'} ${e.what}${e.link ? ` (${e.link})` : ''}`).join(' · ') || '—'}\n\n`
    + C.DIMENSIONS.map((d) => {
      const side = (s) => r.claims.filter((c) => c.shownUnder === d.id && c.side === s);
      const yes = side('yes');
      const no = side('no');
      return `## ${d.label} (raised by: ${r.raisedBy[d.id]})\n\n**YES**\n\n${yes.map(claimLine).join('\n') || '  - never raises this'}\n\n**NO**\n\n${no.map(claimLine).join('\n') || '  - never raises this'}`;
    }).join('\n\n')
    + `\n\n## Who each side says stands with it\n\n`
    + (!r.backers ? `_Backers call failed: ${r.backersError}_\n` : ['yes', 'no'].map((side) => `**${side.toUpperCase()}**: ${r.backers[side].map((b) => `${b.name}${b.verified ? '' : ` (NOT VERIFIED: quote ${b.quoteFound})`}`).join('; ') || '_none named_'}`).join('\n\n')
    + `\n\nBoth sides claim: ${r.backers.shared.map((g) => `${g.yes.map((b) => `"${b.quote}"`).join(', ')} ↔ ${g.no.map((b) => `"${b.quote}"`).join(', ')}`).join('; ') || '_nothing_'}\n`);
}).join('\n\n---\n\n'));
console.log(`Saved tools/.cache/eval/${tag}.json and .md`);
