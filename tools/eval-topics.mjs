// Test the topic explanation (explainTopic in js/topics.js) on every measure × topic.
//   node tools/eval-topics.mjs --tag t1                 (Everyday level)
//   node tools/eval-topics.mjs --measures prop-4 --topics home,vote --level simplest --tag t1-simple
// Reports the model's relevance next to our keyword strength, how many quotes are really in the
// legal text, and the opinion length. Every output goes to tools/.cache/eval/<tag>.md for reading.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
for (const f of ['js/fk.js', 'js/prompts.js', 'js/checker.js', 'js/topics.js']) vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), ctx, { filename: f });
const T = vm.runInContext('({ TOPICS, countTopics, explainTopic, settleRelevance, levelById, TOPIC_PROMPT_VERSION })', ctx);

// --resettle <tag>: re-apply settleRelevance to a saved run (no API calls).
if (args.resettle) {
  const saved = JSON.parse(readFileSync(join(ROOT, 'tools/.cache/eval', `${args.resettle}.json`), 'utf8'));
  for (const r of saved.results.filter((x) => !x.error)) {
    const m = pack.measures.find((x) => x.id === r.measure);
    const s = T.settleRelevance(m, { relevance: r.aiRelevance || r.relevance, facts: r.facts });
    console.log(`${r.label.padEnd(8)} ${r.topicLabel.padEnd(22)} ${r.strength.padEnd(14)} AI ${(r.aiRelevance || r.relevance).padEnd(9)} → shown ${s.relevance.padEnd(9)} sources ${r.facts.map((f) => f.source[0]).join('') || '-'}${s.note ? '   (' + s.note.slice(0, 60) + '…)' : ''}`);
  }
  process.exit(0);
}
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

const measures = args.measures ? pack.measures.filter((m) => args.measures.split(',').includes(m.id)) : pack.measures;
const topics = args.topics ? T.TOPICS.filter((t) => args.topics.split(',').includes(t.id)) : T.TOPICS;
const level = T.levelById(args.level || 'everyday');
const tag = args.tag || `${T.TOPIC_PROMPT_VERSION}-${Date.now()}`;
const jobs = measures.flatMap((m) => topics.map((t) => ({ m, t })));
console.log(`${tag}: ${jobs.length} topic explanations at ${level.label}`);

const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { m, t } = jobs[next++];
    const counted = T.countTopics(m).topics.find((x) => x.id === t.id);
    try {
      const r = await T.explainTopic(m, t.id, `${level.label} (${level.target})`, send);
      results.push({ measure: m.id, label: m.label, topic: t.id, topicLabel: t.label, count: counted.count, strength: counted.strength.label,
        aiRelevance: r.aiRelevance, relevance: r.relevance, relevanceNote: r.relevanceNote, facts: r.facts, opinion: r.opinion, opinionWords: r.opinionWords, cost: r.cost, ms: r.ms });
      process.stdout.write('.');
    } catch (err) {
      results.push({ measure: m.id, topic: t.id, error: err.message });
      process.stdout.write('x');
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log('\n');
const order = (r) => measures.findIndex((m) => m.id === r.measure) * 10 + topics.findIndex((t) => t.id === r.topic);
results.sort((a, b) => order(a) - order(b));
for (const r of results) {
  if (r.error) { console.log(`${r.measure} ${r.topic} ERROR ${r.error}`); continue; }
  const q = r.facts.map((f) => f.quoteFound === 'exact' ? '✓' : f.quoteFound === 'partial' ? '≈' : '✗').join('');
  console.log(`${r.label.padEnd(8)} ${r.topicLabel.padEnd(22)} count ${String(r.count).padStart(3)} ${r.strength.padEnd(14)} → ${r.relevance.padEnd(9)} facts ${r.facts.length} quotes ${q.padEnd(3)} opinion ${r.opinionWords}w  $${r.cost.toFixed(4)} ${(r.ms / 1000).toFixed(1)}s`);
}
const ok = results.filter((r) => !r.error);
const facts = ok.flatMap((r) => r.facts);
console.log(`\nquotes found in the legal text: ${facts.filter((f) => f.quoteFound === 'exact').length} exact, ${facts.filter((f) => f.quoteFound === 'partial').length} partial, ${facts.filter((f) => f.quoteFound === 'missing').length} not found (of ${facts.length})`
  + ` · opinions over 80 words: ${ok.filter((r) => r.opinionWords > 80).length} · cost $${ok.reduce((n, r) => n + r.cost, 0).toFixed(4)} · mean ${(ok.reduce((n, r) => n + r.ms, 0) / ok.length / 1000).toFixed(1)}s`);
mkdirSync(join(ROOT, 'tools/.cache/eval'), { recursive: true });
writeFileSync(join(ROOT, 'tools/.cache/eval', `${tag}.json`), JSON.stringify({ tag, level: level.id, results }, null, 2));
writeFileSync(join(ROOT, 'tools/.cache/eval', `${tag}.md`), ok.map((r) => `## ${r.label} · ${r.topicLabel} (count ${r.count}, ${r.strength} → relevance ${r.relevance})\n\n`
  + r.facts.map((f) => `- ${f.summary}\n  - quote (${f.quoteFound}): “${f.quote}”`).join('\n') + `\n\n**AI opinion (${r.opinionWords} words):** ${r.opinion}\n`).join('\n'));
console.log(`Saved tools/.cache/eval/${tag}.json and .md`);
