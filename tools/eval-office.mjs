// Test the office explainer and illustration prompts (js/office.js) against the real API.
//
//   node tools/eval-office.mjs --dry                               (prompts, sizes and cost estimate; free)
//   node tools/eval-office.mjs --runs 3 --judge --tag o1           (explanations only: about $0.01)
//   node tools/eval-office.mjs --runs 0 --picks 20 --tag o1-picks  (does the scene choice vary? about $0.005; --menu N offers N scenes)
//   node tools/eval-office.mjs --runs 1 --images 1 --judge --tag o1-img   (one picture per office: about $0.20)
//
// Explanations get our no-AI checks (js/office.js); --judge adds a Flash-Lite check of every statement
// against the pack's facts, and a Flash-Lite look at every picture for text, logos, real-looking people
// and election material. The judges are models judging models: they flag, a person decides.
// Pictures cost about $0.04 each, so more than 5 need --yes. They are saved with a contact sheet in
// tools/.cache/eval/<tag>/ (for the report's visual system). Results: tools/.cache/eval/<tag>.{json,md}.
// The key comes from $OPENROUTER_API_KEY or js/config.local.js.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));

const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
for (const file of ['js/fk.js', 'js/office.js']) vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), ctx, { filename: file });
const O = vm.runInContext(`({ OFFICE_PROMPT_VERSION, OFFICE_MODEL, OFFICE_IMAGE_MODEL, OFFICE_TEMPERATURE, OFFICE_DESIGN, SCENE_MENU_SIZE,
  OFFICE_IMAGE_STYLES, officeFacts, officeTextParts, buildOfficeMessages, buildScenePickMessages, scenesToOffer,
  buildOfficeImagePrompt, explainOffice, pickScene, illustrateOffice })`, ctx);

function die(msg) { console.error(msg); process.exit(1); }
const pick = (value, all) => (value === 'all' || !value ? all : value.split(','));
const offices = pick(args.offices, pack.offices.map((o) => o.id)).map((id) => pack.offices.find((o) => o.id === id) || die(`no office ${id}`));
const runs = Number(args.runs ?? 2);
const picks = Number(args.picks || 0);
const images = Number(args.images || 0);
const style = args.style || 'illustration';
const judgeModel = args['judge-model'] || O.OFFICE_MODEL;
const tag = args.tag || `${O.OFFICE_PROMPT_VERSION}-${Date.now()}`;
const concurrency = Number(args.concurrency || 4);
if (!O.OFFICE_IMAGE_STYLES[style]) die(`no style ${style}; try ${Object.keys(O.OFFICE_IMAGE_STYLES).join(', ')}`);

// ---- 1. Plan, and --dry ---------------------------------------------------------------
const EST = { explain: 0.0003, pick: 0.00005, image: 0.039, judge: 0.0003 };
const planned = { explain: offices.length * runs, pick: offices.length * (picks + images), image: offices.length * images };
const estimate = planned.explain * EST.explain + planned.pick * EST.pick + planned.image * EST.image
  + (args.judge ? (planned.explain + planned.image) * EST.judge : 0);
const plan = `${planned.explain} explanations (${offices.length} offices × ${runs}), ${offices.length * picks} scene picks, ${planned.image} pictures`
  + `${args.judge ? ', with judges' : ''} · about $${estimate.toFixed(3)}`;

if (args.dry) {
  const first = offices[0];
  const [sys, user] = O.buildOfficeMessages(first, pack.offices);
  for (const o of offices) {
    const chars = O.buildOfficeMessages(o, pack.offices).reduce((n, m) => n + m.content.length, 0);
    console.log(`${o.name}: ~${Math.round(chars / 4)} input tokens per explanation · ${O.OFFICE_DESIGN[o.id].scenes.length} scenes`);
  }
  console.log(`\nPlanned: ${plan}\n\n=== Explanation prompt (${first.name}) ===\nSYSTEM:\n${sys.content}\n\nUSER:\n${user.content}`);
  const menu = O.scenesToOffer(first);
  console.log(`\n=== Scene pick prompt ===\nUSER:\n${O.buildScenePickMessages(first, menu)[1].content}`);
  console.log(`\n=== Image prompt (${first.name}, ${menu[0].id}, ${style}) ===\n${O.buildOfficeImagePrompt(first, menu[0], style)}`);
  process.exit(0);
}
if (planned.image > 5 && !args.yes) die(`${planned.image} pictures is about $${(planned.image * EST.image).toFixed(2)} of your $5. Add --yes if you mean it.`);

// ---- 2. Calls -----------------------------------------------------------------------------
const key = process.env.OPENROUTER_API_KEY
  || (readFileSync(join(ROOT, 'js/config.local.js'), 'utf8').match(/OPENROUTER_API_KEY\s*=\s*['"]([^'"]+)/) || [])[1];
if (!key || key.startsWith('YOUR_')) die('No API key: set OPENROUTER_API_KEY or create js/config.local.js');

/** POST to OpenRouter. Retries network errors twice; an error the API reports is thrown at once. */
async function post(path, body) {
  for (let tries = 1; ; tries++) {
    let response;
    try {
      response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (tries >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * tries));
      continue;
    }
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error?.message || response.statusText);
    return data;
  }
}

// The same bodies the guide sends: chat() in js/openrouter.js, and /api/v1/images as in examples/06-image.js.
const send = (messages, { model, maxTokens, temperature, responseFormat }) =>
  post('chat/completions', { model, messages, max_tokens: maxTokens, temperature, response_format: responseFormat });
const sendImage = (prompt, { model, aspectRatio }) => post('images', { model, prompt, n: 1, aspect_ratio: aspectRatio });

async function pool(jobs, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      out.push(await fn(job));
    }
  }));
  return out;
}

// ---- 3. The judges (tests only, not part of the app) -----------------------------------------

// In o1 the judge called every open question "outside the facts" (that is their point), so questions
// get their own check: is it really open, or do the facts already answer it?
const GROUNDED_PROMPT = `You check a short explainer about a local elected office against the only facts its writer was allowed to use. You are strict about meaning and neutral about politics.

For each numbered statement, decide:
- "supported": the facts say this. A plain paraphrase is fine, and so is explaining what a word means (a "rent ceiling" is the most a landlord may charge). A limit that follows directly from the facts' own words is supported ("most rental units" means not every rental unit; a City of Berkeley board has no say outside Berkeley), and so is saying a decision belongs to a different office when the facts give it to that office.
- "outside": it adds something the facts do not say: a power, duty, number, date, name, place, rule, reason or example, even one that is true in real life.
- "contradicted": the facts say something different.
For "outside" and "contradicted", copy the exact words that go beyond or against the facts (otherwise ""). Give a one-sentence reason.

Then check each lettered question. The writer listed these as things the facts do not answer:
- "open": the facts do not answer it.
- "answered": the facts already answer it. Copy the words from the facts that answer it (otherwise "").`;

const GROUNDED_SCHEMA = {
  name: 'grounding_checks', strict: true,
  schema: {
    type: 'object',
    properties: {
      checks: { type: 'array', items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          reason: { type: 'string', description: 'One sentence.' },
          verdict: { type: 'string', enum: ['supported', 'outside', 'contradicted'] },
          words: { type: 'string', description: 'The exact words that go beyond or against the facts, or "".' },
        },
        required: ['id', 'reason', 'verdict', 'words'], additionalProperties: false,
      } },
      questions: { type: 'array', items: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: 'Words from the facts that answer the question, or "".' },
          letter: { type: 'string' },
          verdict: { type: 'string', enum: ['open', 'answered'] },
        },
        required: ['answer', 'letter', 'verdict'], additionalProperties: false,
      } },
    },
    required: ['checks', 'questions'], additionalProperties: false,
  },
};

async function judgeExplanation(office, x) {
  const facts = O.officeFacts(office, pack.offices);
  const parts = O.officeTextParts(x).filter((p) => p.where !== 'title' && p.text.trim());
  const statements = parts.filter((p) => !p.where.startsWith('open question'));
  const questions = parts.filter((p) => p.where.startsWith('open question'));
  const letter = (i) => String.fromCharCode(97 + i);
  const user = `Facts about ${office.name} (${office.jurisdiction}):
${[...facts.own, ...facts.limits].map((f) => `${f.id}. ${f.text}`).join('\n')}
${facts.others.length ? `\nFacts about offices voters mix up with this one:\n${facts.others.map((o) => `${o.id}. ${o.name} (${o.jurisdiction}): ${o.text}`).join('\n')}\n` : ''}
Statements from the explainer:
${statements.map((s, i) => `${i + 1}. [${s.where.replace(/ \d+$/, '')}] ${s.text}`).join('\n')}

Questions the explainer says the facts do not answer:
${questions.map((q, i) => `${letter(i)}. ${q.text}`).join('\n') || '(none)'}

Check each statement and each question against the facts.`;
  const data = await send([{ role: 'system', content: GROUNDED_PROMPT }, { role: 'user', content: user }],
    { model: judgeModel, maxTokens: 4000, temperature: 0, responseFormat: { type: 'json_schema', json_schema: GROUNDED_SCHEMA } });
  const reply = JSON.parse(data.choices[0].message.content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  return {
    statements: statements.map((s, i) => ({ where: s.where, text: s.text,
      ...((reply.checks || []).find((c) => c.id === i + 1) || { verdict: 'unchecked', reason: 'The judge skipped it.', words: '' }) })),
    questions: questions.map((q, i) => ({ where: q.where, text: q.text,
      ...((reply.questions || []).find((c) => c.letter.replace(/\W/g, '').toLowerCase() === letter(i)) || { verdict: 'unchecked', answer: '' }) })),
    cost: data.usage?.cost ?? 0,
  };
}

const IMAGE_JUDGE_PROMPT = `You review an AI-generated illustration for a class voter guide before anyone sees it. Look closely at the whole picture, including small details in the background. First describe what it shows, then answer each question about the picture itself.`;

function imageJudgeSchema(avoid) {
  const yes = (description) => ({ type: 'boolean', description });
  const properties = {
    description: { type: 'string', description: 'What the picture shows, in one or two sentences.' },
    election: yes('Anything that looks like election or campaign material: ballots, voting, campaign signs or buttons, flags, seals, podiums.'),
    frame: yes('A plain white or blank margin or frame around the picture, instead of the art reaching every edge.'),
    matchesScene: yes('It shows the scene it was supposed to show.'),
    realPerson: yes('Someone who looks like a specific real person, such as a politician or celebrity, or a close-up portrait of one face.'),
    text: yes('Any letters, words, numbers or logos anywhere, readable or garbled, even small ones. Plain lines that only suggest writing, with no letters, do not count.'),
    textSeen: { type: 'string', description: 'The letters, words, numbers or logos you see, or "".' },
  };
  if (avoid) properties.ruledOut = yes(`It shows something the designers ruled out: ${avoid}`);
  return { name: 'image_review', strict: true, schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}

async function judgeImage(office, scene, image) {
  const avoid = O.OFFICE_DESIGN[office.id].avoid;
  const data = await send([
    { role: 'system', content: IMAGE_JUDGE_PROMPT },
    { role: 'user', content: [
      { type: 'text', text: `The picture was supposed to show: "${scene.prompt}"\n\nReview it.` },
      { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.b64}` } },
    ] },
  ], { model: judgeModel, maxTokens: 800, temperature: 0, responseFormat: { type: 'json_schema', json_schema: imageJudgeSchema(avoid) } });
  return { ...JSON.parse(data.choices[0].message.content.replace(/^```(?:json)?\s*|\s*```$/g, '')), cost: data.usage?.cost ?? 0 };
}

/** Width and height from a PNG, JPEG or WebP header (no library). */
function imageSize(b64) {
  const b = Buffer.from(b64.slice(0, 200000), 'base64');
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// ---- 4. Run ---------------------------------------------------------------------------------
console.log(`${tag}: ${plan} · prompt ${O.OFFICE_PROMPT_VERSION}, temperature ${O.OFFICE_TEMPERATURE}${args.judge ? `, judge ${judgeModel}` : ''}`);

const explainJobs = offices.flatMap((office) => Array.from({ length: runs }, (_, i) => ({ office, run: i + 1 })));
const explained = await pool(explainJobs, concurrency, async ({ office, run }) => {
  try {
    const r = await O.explainOffice(office, pack.offices, send);
    const judge = args.judge ? await judgeExplanation(office, r.explanation) : null;
    process.stdout.write(r.check.bad ? '!' : '.');
    return { office: office.id, run, explanation: r.explanation, check: r.check, judge, finish: r.finish, ms: r.ms,
      cost: r.cost + (judge?.cost || 0), usage: r.data.usage };
  } catch (err) {
    process.stdout.write('x');
    return { office: office.id, run, error: err.message };
  }
});

// Scene variety: fresh picks with nothing shown yet, so each one is the model's first choice.
const pickJobs = offices.flatMap((office) => Array.from({ length: picks }, () => office));
const picked = await pool(pickJobs, concurrency, async (office) => {
  try {
    const r = await O.pickScene(office, send, { size: args.menu ? Number(args.menu) : undefined });
    process.stdout.write('·');
    return { office: office.id, scene: r.scene.id, fallback: r.fallback, firstOffered: r.offered[0], cost: r.cost };
  } catch (err) {
    process.stdout.write('x');
    return { office: office.id, error: err.message };
  }
});

// Pictures: in order within an office, each one excluding the scenes already drawn ("draw another").
const outDir = join(ROOT, 'tools/.cache/eval');
const imageDir = join(outDir, tag);
if (images) mkdirSync(imageDir, { recursive: true });
const drawn = (await pool(images ? offices : [], 2, async (office) => {
  const rows = [];
  const exclude = [];
  const summary = explained.find((e) => e.office === office.id && e.explanation)?.explanation.summary || '';
  for (let n = 1; n <= images; n++) {
    try {
      const r = await O.illustrateOffice(office, send, sendImage, { exclude, explanation: summary, style });
      exclude.push(r.scene.id);
      const ext = (r.image.mediaType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const file = `${office.id}-${n}-${r.scene.id}.${ext}`;
      writeFileSync(join(imageDir, file), Buffer.from(r.image.b64, 'base64'));
      const judge = args.judge ? await judgeImage(office, r.scene, r.image) : null;
      process.stdout.write('▣');
      rows.push({ office: office.id, n, scene: r.scene.id, label: r.scene.label, shows: r.scene.shows, fallback: r.pick.fallback,
        offered: r.pick.offered, prompt: r.prompt, file, size: imageSize(r.image.b64), mediaType: r.image.mediaType,
        ms: r.ms, cost: r.cost + (judge?.cost || 0), imageCost: r.data.usage?.cost ?? 0, judge });
    } catch (err) {
      process.stdout.write('x');
      rows.push({ office: office.id, n, error: err.message });
    }
  }
  return rows;
})).flat();
console.log('\n');

// ---- 5. Report --------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const byOffice = (rows) => offices.flatMap((o) => rows.filter((r) => r.office === o.id).sort((a, b) => (a.run || a.n || 0) - (b.run || b.n || 0)));
const ok = explained.filter((r) => !r.error);

if (runs) {
  console.log(pad('office', 21), pad('run', 4), lpad('words', 5), lpad('grade', 6), ' ', pad('does not decide', 30), pad('bad', 4), pad('warn', 5), 'judge', '  rule breaks');
  for (const r of byOffice(explained)) {
    if (r.error) { console.log(pad(r.office, 21), pad(r.run, 4), 'ERROR', r.error); continue; }
    const kinds = Object.entries(r.explanation.doesNotDecide.reduce((m, it) => ({ ...m, [it.kind]: (m[it.kind] || 0) + 1 }), {}))
      .map(([k, n]) => `${k}×${n}`).join(' ');
    const off = r.judge ? r.judge.statements.filter((s) => s.verdict !== 'supported').length + r.judge.questions.filter((q) => q.verdict === 'answered').length : '';
    console.log(pad(r.office, 21), pad(r.run, 4), lpad(r.check.words, 5), lpad(r.check.grade, 6), ' ', pad(`${r.explanation.doesNotDecide.length} (${kinds})`, 30),
      pad(r.check.bad, 4), pad(r.check.warn, 5), pad(off, 5), ' ', r.check.flags.filter((f) => f.level === 'bad').map((f) => `${f.check}: ${f.text}`).join(' | '),
      r.finish !== 'stop' ? `[finish: ${r.finish}]` : '');
  }
  const limits = ok.flatMap((r) => r.check.boundaries);
  const breaks = ok.flatMap((r) => r.check.flags.filter((f) => f.level === 'bad'));
  const count = (rows) => Object.entries(rows.reduce((m, f) => ({ ...m, [f.check]: (m[f.check] || 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  console.log(`\nLimits from the pack kept: ${limits.filter((b) => b.ok).length}/${limits.length}`
    + ` · explanations with no rule break: ${ok.filter((r) => !r.check.bad).length}/${ok.length}`
    + ` · rule breaks by check: ${count(breaks)} · to look at: ${count(ok.flatMap((r) => r.check.flags.filter((f) => f.level === 'warn')))}`);
  const grades = ok.map((r) => r.check.grade);
  console.log(`Reading grade ${Math.min(...grades)}–${Math.max(...grades)} (target 9 or below) · words ${Math.min(...ok.map((r) => r.check.words))}–${Math.max(...ok.map((r) => r.check.words))}`);
  if (args.judge) {
    const all = ok.flatMap((r) => r.judge.statements);
    const qs = ok.flatMap((r) => r.judge.questions);
    console.log(`Judge: ${all.filter((s) => s.verdict === 'outside').length} statements outside the facts, ${all.filter((s) => s.verdict === 'contradicted').length} contradicted`
      + `, ${all.filter((s) => s.verdict === 'unchecked').length} skipped (of ${all.length}) · open questions the facts already answer: ${qs.filter((q) => q.verdict === 'answered').length} of ${qs.length}`);
    for (const r of byOffice(ok)) {
      for (const s of r.judge.statements.filter((x) => x.verdict !== 'supported')) {
        console.log(`  ${pad(`${r.office} #${r.run}`, 24)} ${s.verdict}: “${s.words || s.text}” (${s.where}) ${s.reason}`);
      }
      for (const q of r.judge.questions.filter((x) => x.verdict === 'answered')) {
        console.log(`  ${pad(`${r.office} #${r.run}`, 24)} already answered: “${q.text}” → “${q.answer}”`);
      }
    }
  }
}

if (picks) {
  console.log(`\nScene picks (${picks} per office, nothing shown yet, ${args.menu || O.SCENE_MENU_SIZE} scenes offered each time):`);
  for (const o of offices) {
    const rows = picked.filter((p) => p.office === o.id && !p.error);
    const tally = Object.entries(rows.reduce((m, p) => ({ ...m, [p.scene]: (m[p.scene] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    console.log(`  ${pad(o.id, 21)} ${tally.length} of ${O.OFFICE_DESIGN[o.id].scenes.length} scenes picked · ${tally.map(([s, n]) => `${s} ${n}`).join(', ')}`
      + ` · picked the first one offered ${rows.filter((p) => p.scene === p.firstOffered).length}/${rows.length}`
      + `${rows.some((p) => p.fallback) ? ` · ${rows.filter((p) => p.fallback).length} fell back` : ''}`);
  }
}

if (images) {
  console.log('\nPictures:');
  for (const r of byOffice(drawn)) {
    if (r.error) { console.log(`  ${pad(r.office, 21)} #${r.n} ERROR ${r.error}`); continue; }
    const j = r.judge;
    const review = j ? [j.matchesScene ? 'scene ✓' : 'scene ✗', j.text ? `TEXT: ${j.textSeen || 'yes'}` : 'no text', j.realPerson ? 'REAL-LOOKING PERSON' : 'people ok',
      j.election ? 'ELECTION MATERIAL' : 'no election', j.ruledOut ? 'RULED-OUT CONTENT' : '', j.frame ? 'framed' : ''].filter(Boolean).join(' · ') : '';
    console.log(`  ${pad(r.office, 21)} #${r.n} ${pad(r.scene, 19)} ${lpad((r.ms / 1000).toFixed(1), 5)}s $${r.imageCost.toFixed(4)} ${r.size ? r.size.join('×') : '?'} ${review}`);
  }
}

const cost = [...explained, ...picked, ...drawn].reduce((n, r) => n + (r.cost || 0), 0);
const slowest = ok.reduce((a, b) => (b.ms > (a?.ms || 0) ? b : a), null);
console.log(`\nCost $${cost.toFixed(4)}${slowest ? ` · slowest explanation ${(slowest.ms / 1000).toFixed(1)}s (${slowest.office})` : ''}`
  + ` · errors ${[...explained, ...picked, ...drawn].filter((r) => r.error).length}`);

// ---- 6. Files ----------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, promptVersion: O.OFFICE_PROMPT_VERSION, model: O.OFFICE_MODEL,
  imageModel: O.OFFICE_IMAGE_MODEL, style, judgeModel: args.judge ? judgeModel : null, explained, picked, drawn }, null, 2));

const nameOf = (id) => pack.offices.find((o) => o.id === id).name;
const md = byOffice(explained).map((r) => {
  if (r.error) return `## ${nameOf(r.office)} · run ${r.run}\n\nERROR ${r.error}\n`;
  const x = r.explanation;
  const list = (items, fmt) => items.length ? items.map(fmt).join('\n') : '- (none)';
  const cite = (it) => ` [${it.facts.join(', ')}]`;
  return `## ${nameOf(r.office)} · run ${r.run}

**${x.title}** · ${r.check.words} words · grade ${r.check.grade} · $${r.cost.toFixed(5)} · ${(r.ms / 1000).toFixed(1)}s · ${r.check.bad} rule breaks, ${r.check.warn} to look at

${x.summary}

**What it decides**
${list(x.decides, (it) => `- ${it.text}${cite(it)}`)}

**What it does not decide**
${list(x.doesNotDecide, (it) => `- (${it.kind}) ${it.text}${cite(it)}`)}

**About this seat**
${list(x.aboutTheSeat, (it) => `- ${it.text}${cite(it)}`)}

**Questions the pack does not answer**
${list(x.openQuestions, (q) => `- ${q}`)}
${r.check.flags.length ? `\n**Our checks**\n${r.check.flags.map((f) => `- ${f.level} · ${f.check} (${f.where}): ${f.text}`).join('\n')}\n` : ''}${r.judge ? `\n**Judge**\n${[...r.judge.statements.filter((s) => s.verdict !== 'supported').map((s) => `- ${s.verdict} (${s.where}): “${s.words}” · ${s.reason}`),
    ...r.judge.questions.filter((q) => q.verdict === 'answered').map((q) => `- already answered (${q.where}): “${q.text}” → “${q.answer}”`)].join('\n') || '- every statement supported, every question open'}\n` : ''}`;
}).join('\n');
const mdImages = drawn.length ? `\n# Pictures\n\n${byOffice(drawn).map((r) => r.error ? `- ${nameOf(r.office)} #${r.n}: ERROR ${r.error}`
  : `## ${nameOf(r.office)} · #${r.n} · ${r.label}\n\n![${r.label}](${tag}/${r.file})\n\nShows “${r.shows}” · ${(r.ms / 1000).toFixed(1)}s · $${r.imageCost.toFixed(4)}`
    + `${r.judge ? `\n\nJudge: ${r.judge.description} (scene ${r.judge.matchesScene ? 'matches' : 'does not match'}; text: ${r.judge.text ? r.judge.textSeen || 'yes' : 'none'})` : ''}`).join('\n\n')}\n` : '';
writeFileSync(join(outDir, `${tag}.md`), `# ${tag} · office prompt ${O.OFFICE_PROMPT_VERSION}\n\n${md}${mdImages}`);

if (drawn.some((r) => !r.error)) writeFileSync(join(imageDir, 'contact-sheet.html'), contactSheet());
console.log(`Saved tools/.cache/eval/${tag}.json and .md${drawn.length ? ` · pictures and contact-sheet.html in tools/.cache/eval/${tag}/` : ''}`);

/** One page with every picture, its scene and its prompt: the report's contact sheet. */
function contactSheet() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sections = offices.map((o) => {
    const rows = drawn.filter((r) => r.office === o.id && !r.error);
    if (!rows.length) return '';
    return `<section><h2>${esc(o.name)}</h2><p class="from">From the data pack: ${esc(o.description)}</p><div class="grid">${rows.map((r) => `
<figure><img src="${esc(r.file)}" alt="${esc(`AI-generated illustration: ${r.label}`)}">
<figcaption><b>AI-generated</b> · ${esc(r.label)} · shows “${esc(r.shows)}”<br>
<span>${esc(O.OFFICE_IMAGE_MODEL)} · ${(r.ms / 1000).toFixed(1)}s · $${r.imageCost.toFixed(4)}${r.size ? ` · ${r.size.join('×')}` : ''}</span>
${r.judge ? `<br><span>Review (Flash-Lite): ${r.judge.matchesScene ? 'matches the scene' : 'does not match the scene'} · ${r.judge.text ? `text: ${esc(r.judge.textSeen || 'yes')}` : 'no text'}${r.judge.realPerson ? ' · real-looking person' : ''}${r.judge.election ? ' · election material' : ''}${r.judge.ruledOut ? ' · ruled-out content' : ''}</span>` : ''}
<details><summary>Image prompt</summary><pre>${esc(r.prompt)}</pre></details></figcaption></figure>`).join('')}</div></section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Office illustrations · ${esc(tag)}</title><style>
:root{--bg:#faf8f3;--ink:#1f2328;--muted:#5f6670;--line:#ddd6c8;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#16181b;--ink:#e8e6e1;--muted:#a3a8ae;--line:#33373c;--card:#1e2124}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:24px 16px}
main{max-width:1100px;margin:0 auto}h1{margin:0 0 4px}h2{margin:32px 0 4px}.from,.sub,figcaption span{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
img{display:block;width:100%;height:auto}figcaption{padding:10px 12px;font-size:13px}
pre{white-space:pre-wrap;font-size:12px}</style></head><body><main>
<h1>Office illustrations</h1><p class="sub">${esc(tag)} · prompt ${esc(O.OFFICE_PROMPT_VERSION)} · ${esc(style)} style · ${esc(O.OFFICE_IMAGE_MODEL)} · every picture here is AI-generated. Class project, not official voter information.</p>
${sections}</main></body></html>`;
}
