// Print the topic keyword counts for every measure (no AI, free).
//   node tools/topics-report.mjs            (table)
//   node tools/topics-report.mjs --context prop-40 health   (every match in context, to spot false hits)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(ROOT, 'js/topics.js'), 'utf8'), ctx, { filename: 'js/topics.js' });
const T = vm.runInContext('({ TOPICS, countTopics, countableText, topicRegex })', ctx);
const [, , flag, measureId, topicId] = process.argv;

if (flag === '--context') {
  const m = pack.measures.find((x) => x.id === measureId);
  const { text } = T.countableText(m);
  for (const hit of text.matchAll(T.topicRegex(T.TOPICS.find((t) => t.id === topicId)))) {
    console.log(`…${text.slice(Math.max(0, hit.index - 60), hit.index).replace(/\s+/g, ' ')}[${hit[0]}]${text.slice(hit.index + hit[0].length, hit.index + hit[0].length + 40).replace(/\s+/g, ' ')}…`);
  }
  process.exit(0);
}

for (const m of pack.measures) {
  const r = T.countTopics(m);
  console.log(`\n${m.label}: ${r.words} words counted${r.skipped.length ? ` (left out: ${r.skipped.join('; ')})` : ''}`);
  for (const t of r.topics) {
    console.log(`  ${t.label.padEnd(22)} ${String(t.count).padStart(4)}  ${String(t.per1000).padStart(5)}/1k  ${t.strength.label.padEnd(14)} ${t.top.slice(0, 8).map(([w, n]) => `${w} ${n}`).join(', ')}`);
  }
}
