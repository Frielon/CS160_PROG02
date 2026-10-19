// Represent! Functionality 1: read a ballot measure at the reading level and length you choose.
//
// "As written" is the certified text and makes no API call. Every other rendering comes from
// renderMeasure() in js/prompts.js: the model writes from the legal text, our code measures the
// result (words, Flesch–Kincaid grade, key facts), a second model call checks each claim against
// the legal text (js/checker.js), short versions get one checked retry, and a final fix edits
// whatever sentences the fact check still flags (each fix is checked again before it is used).
// Everything generated is labeled as generated, with the full text one click away.
//
// This is the guide's "Read a measure" tab (guide.html#read). It is a module: js/app.js loads the
// pack, shows the tab, shares the picked measure with the Compare tab, and keeps the session cost.

const MODEL_NAME = 'Gemini 2.5 Flash-Lite';
// Estimates only, shown before a call. The real cost comes back in usage.cost and is what we count.
const PRICE_PER_TOKEN = { input: 0.10 / 1e6, output: 0.40 / 1e6 };
const OUTPUT_TOKENS = { headline: 40, short: 150, standard: 450, complete: 4000, none: 4000 };
const CHECK_NAME = 'Gemini 2.5 Flash';
const CHECK_PRICE_PER_TOKEN = { input: 0.30 / 1e6, output: 2.50 / 1e6 };
const CHECK_OUTPUT_TOKENS = 3000; // its claim list plus the model's own thinking

const state = { level: 'everyday', length: 'short', debug: false, topic: null, highlightTopic: null };
const results = new Map(); // "measure|level|length|promptVersion" → finished rendering
const running = new Map(); // same key → { step, started, draft, asks } while a call is out
const checking = new Set(); // keys whose Complete version is being checked or fixed on request
const topicResults = new Map(); // "measure|topic|level|promptVersion" → topic explanation
const topicRuns = new Map(); // same key → { started } while the call is out

const $ = (id) => document.getElementById(id);
const resultKey = () => [app.measureId, state.level, state.length, PROMPT_VERSION].join('|');
const measure = () => app.pack.measures.find((m) => m.id === app.measureId);

// ---- 1. Start: js/app.js calls init() once the pack is in, and drawAll() to show the tab ------

registerView('read', { init: restoreChoice, draw: drawAll });

function drawAll() {
  drawPicker();
  drawTopics();
  drawControls();
  drawOutput();
}

// The last level and length are a per-browser convenience; the page works the same without them.
// The measure is the guide's (js/app.js remembers it), shared with the Compare tab.
function restoreChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem('represent.choice') || '{}');
    if (levelById(saved.level)) state.level = saved.level;
    if (lengthById(saved.length) && !lengthById(saved.length).debug) state.length = saved.length;
  } catch { /* storage blocked: keep the defaults */ }
}

function choose(change) {
  const { measureId, ...rest } = change;
  Object.assign(state, rest);
  try {
    localStorage.setItem('represent.choice', JSON.stringify({ level: state.level, length: state.length }));
  } catch { /* fine */ }
  if (measureId && measureId !== app.measureId) go({ measureId }); // redraws this tab
  else drawAll();
}

// ---- 2. Session cost: js/app.js keeps it for all three tabs (addCost, money) -----------------

// ---- 3. Measure picker ----------------------------------------------------------------

function drawPicker() {
  const longest = Math.max(...app.pack.measures.map((m) => m.wordCount));
  $('read-picker').replaceChildren(...app.pack.measures.map((m) => h('button', {
    type: 'button', class: 'pick', 'aria-pressed': String(m.id === app.measureId),
    onclick: () => choose({ measureId: m.id }),
  },
  h('span', { class: 'pick-label' }, m.label),
  h('span', { class: 'pick-title' }, titleCase(m.official.title)),
  h('span', { class: 'pick-len' },
    h('span', { class: 'len-bar', style: `width:${Math.max(2, (100 * m.wordCount) / longest)}%` }),
    h('span', { class: 'len-num' }, `${fmt(m.wordCount)} words of legal text`)))));
}

/** "REPEALS PROHIBITION ... LEGISLATIVE STATUTE." → "Repeals prohibition ..." (drop the measure-type tail). */
function titleCase(title) {
  const main = title.split('.')[0].toLowerCase();
  return main.charAt(0).toUpperCase() + main.slice(1);
}

// ---- 4. Controls -----------------------------------------------------------------------

function drawControls() {
  const m = measure();
  const asWritten = state.level === 'as-written';
  const lengths = LENGTHS.filter((l) => !l.debug || state.debug);

  $('controls').replaceChildren(...[
    h('fieldset', { class: 'choice' },
      h('legend', {}, 'Reading level'),
      READING_LEVELS.map((lv) => option('level', lv.id, state.level === lv.id, lv.label, lv.target, lv.reads,
        () => choose({ level: lv.id })))),
    h('fieldset', { class: 'choice', disabled: asWritten },
      h('legend', {}, 'Length'),
      asWritten && h('p', { class: 'hint' }, 'As written is always the complete certified text. To shorten it, a model has to rewrite it: pick a reading level.'),
      lengths.map((ln) => option('length', ln.id, state.length === ln.id, ln.label, ln.target, null,
        () => choose({ length: ln.id })))),
    !asWritten && notices(m),
    !asWritten && generatePanel(m),
    h('label', { class: 'debug' },
      h('input', { type: 'checkbox', checked: state.debug, onchange: (e) => choose({ debug: e.target.checked, length: e.target.checked ? state.length : (lengthById(state.length).debug ? 'short' : state.length) }) }),
      ' Debug: offer “No length rule”'),
  ].filter(Boolean));
}

function option(name, value, checked, label, target, reads, onchange) {
  return h('label', { class: 'opt' },
    h('input', { type: 'radio', name, value, checked, onchange }),
    h('span', { class: 'opt-body' },
      h('span', { class: 'opt-label' }, label, h('span', { class: 'opt-target' }, target)),
      reads && h('span', { class: 'opt-reads' }, reads)));
}

/** What the reader should know before paying for this combination. */
function notices(m) {
  const list = [];
  const warn = comboWarning(state.level, state.length);
  if (warn) list.push(['warn', warn]);
  if (sourceTooShort(m, state.length)) {
    list.push(['info', `${m.label}’s legal text is only ${fmt(m.wordCount)} words. A ${lengthById(state.length).label} version (${lengthById(state.length).target}) could only be filled with padding or outside facts, so the model is told to write less.`]);
  }
  if (['complete', 'none'].includes(state.length) && m.wordCount > 5000) {
    list.push(['info', `This sends all ${fmt(m.wordCount)} words and asks for every provision back. Expect 20 to 45 seconds, and a long result.`]);
  }
  return list.length ? h('div', { class: 'notices' }, list.map(([kind, text]) => h('p', { class: 'notice ' + kind }, text))) : null;
}

function estimate(m, lengthId = state.length) {
  const chars = buildRenderMessages(m, state.level, lengthId).reduce((n, x) => n + x.content.length, 0);
  const inputTokens = Math.round(chars / 4);
  const write = inputTokens * PRICE_PER_TOKEN.input + OUTPUT_TOKENS[lengthId] * PRICE_PER_TOKEN.output;
  const check = inputTokens * CHECK_PRICE_PER_TOKEN.input + CHECK_OUTPUT_TOKENS * CHECK_PRICE_PER_TOKEN.output;
  return { inputTokens, write, check, auto: AUTO_REVISE_LENGTHS.includes(lengthId) };
}

function generatePanel(m) {
  const key = resultKey();
  const busy = running.has(key);
  const done = results.has(key);
  const est = estimate(m);
  return h('div', { class: 'generate' },
    h('button', { type: 'button', class: 'primary', disabled: busy, onclick: generate },
      busy ? 'Writing…' : done ? 'Write a new version' : 'Rewrite with AI'),
    h('p', { class: 'small muted' },
      `Sends about ${fmt(est.inputTokens)} tokens of legal text. Writing: up to about ${money(est.write)}`,
      est.auto ? `; fact check: about ${money(est.check)}. Each can run twice if the draft is sent back once. Repeat calls on the same measure cost less (the provider caches the legal text).`
        : '. Complete versions are not fact-checked automatically.'));
}

// ---- 5. Output -------------------------------------------------------------------------

function drawOutput() {
  const m = measure();
  const key = resultKey();
  let view;
  if (state.level === 'as-written') view = certifiedView(m);
  else if (running.has(key)) view = progressView(m, running.get(key));
  else if (results.has(key)) view = resultView(m, results.get(key));
  else view = readyView(m);
  $('output').replaceChildren(view);
}

function readyView(m) {
  const level = levelById(state.level);
  const length = lengthById(state.length);
  return h('div', { class: 'ready' },
    h('p', { class: 'eyebrow' }, `${m.label} · ${level.label} · ${length.label}`),
    h('h2', {}, 'Nothing generated yet'),
    h('p', {}, `Press “Rewrite with AI” to have ${MODEL_NAME} rewrite the full legal text of ${m.label} at ${level.target}, ${length.target}. `
      + `Our code then counts the words, measures the reading grade, and looks for key facts, and ${CHECK_NAME} checks each claim against the legal text.`),
    h('p', {}, h('button', { type: 'button', class: 'linkish', onclick: () => choose({ level: 'as-written' }) }, 'Or read the certified text as written'), ' (no AI, free).'));
}

// ---- 5a. The certified text --------------------------------------------------------------

function certifiedView(m) {
  const fk = fleschKincaid(operativeText(m.fullText));
  const headings = [];
  const body = h('div', { class: 'legal' },
    parseMarked(m.fullTextMarked).map((runs, i) => renderLegalParagraph(runs, 'marked', `${m.id}-p${i}`, headings)));
  const topic = TOPICS.find((t) => t.id === state.highlightTopic);
  const hits = topic ? markMatches(body, topicRegex(topic)) : [];
  return h('article', { class: 'card certified' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge cert' }, 'Certified text'),
      h('span', { class: 'card-kind' }, 'As written · no AI'),
      h('p', { class: 'provenance' }, `The full legal text of ${m.label} from the ${app.pack.meta.guide}, exactly as certified. `,
        link(m.sources.legalTextPdf, 'Official PDF'), ' · ', link(m.sources.officialPage, 'Official guide page'))),
    h('div', { class: 'meters' },
      meter('Words', fmt(m.wordCount), 'the whole measure'),
      meter('Reading grade', fk.grade, 'Flesch–Kincaid, struck-out words removed'),
      meter('Cost', '$0', 'no model involved')),
    h('p', { class: 'legend' }, h('del', {}, 'struck out'), ' = removed from current law · ', h('ins', {}, 'italic'), ' = added by this measure'),
    topic && h('p', { class: 'topic-banner' },
      `Highlighting ${hits.length} “${topic.label}” word${hits.length === 1 ? '' : 's'}. `,
      hits.length > 0 && h('button', { type: 'button', class: 'linkish', onclick: () => hits[0].scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 'Jump to the first'),
      hits.length > 0 && ' · ',
      h('button', { type: 'button', class: 'linkish', onclick: () => choose({ highlightTopic: null }) }, 'Clear'),
      h('span', { class: 'muted' }, ' (the count above leaves out the opening paragraph and procedural sections, so the numbers can differ slightly)')),
    headings.length > 1 && h('div', { class: 'toc' }, h('span', { class: 'small muted' }, 'Jump to'),
      headings.map((x) => h('button', { type: 'button', class: 'toc-item level-' + x.level,
        onclick: () => $(x.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, x.label))),
    body);
}

function meter(label, value, sub, status) {
  return h('div', { class: 'meter-box' + (status ? ' ' + status.kind : '') },
    h('div', { class: 'meter-label' }, label),
    h('div', { class: 'meter-value' }, value, status && h('span', { class: 'meter-status' }, status.text)),
    h('div', { class: 'meter-sub' }, sub));
}

// ---- 5b. Generating ------------------------------------------------------------------------

const STEP_SUFFIX = { check: ' (fact check)', revise: ' (revision)', recheck: ' (fact check of revision)', fix: ' (final fix)' };

const levelLabel = (levelId) => `${levelById(levelId).label} (${levelById(levelId).target})`;

async function generate() {
  const m = measure();
  const key = resultKey();
  const { level, length } = state;
  if (running.has(key)) return;
  const job = { step: 'draft', started: Date.now() };
  running.set(key, job);
  drawAll();
  const tick = setInterval(() => { if (resultKey() === key) updateElapsed(job); }, 200);

  const label = `${m.label} · ${levelById(level).label} · ${lengthById(length).label}`;
  const send = async (messages, opts) => {
    const data = await chat(messages, opts);
    addCost(label + (STEP_SUFFIX[job.step] || ''), data.usage?.cost ?? 0, 'read');
    return data;
  };
  try {
    const result = await renderMeasure(m, level, length, send, (step, r, extra) => {
      job.step = step;
      if (step === 'check' || step === 'revise') job.draft = r;
      if (step === 'recheck') job.revision = r;
      if (step === 'revise') job.asks = extra;
      if (step === 'fix') Object.assign(job, { fixing: r, fixFlags: extra });
      if (resultKey() === key) drawOutput();
    }, {
      factCheck: (text) => checkClaims(m, text, send),
      finalFix: (text, fc) => fixRendering(m, levelLabel(level), text, fc, send, { wordRange: lengthById(length).words }),
    });
    results.set(key, { ...result, at: Date.now(), ms: Date.now() - job.started });
  } catch (err) {
    results.set(key, { error: err.message, at: Date.now() });
  } finally {
    clearInterval(tick);
    running.delete(key);
    if (resultKey() === key) drawAll(); else drawControls();
  }
}

/** Fact-check (what = 'check') or fix (what = 'fix') a Complete version on request. */
async function onRequest(what, m, key, result) {
  if (checking.has(key)) return;
  checking.add(key);
  drawOutput();
  const { level, length } = state;
  const label = `${m.label} · ${levelById(level).label} · ${lengthById(length).label} (${what === 'check' ? 'fact check' : 'final fix'})`;
  const send = async (messages, opts) => {
    const data = await chat(messages, opts);
    addCost(label, data.usage?.cost ?? 0, 'read');
    return data;
  };
  const r = result.kept;
  try {
    if (what === 'check') {
      r.factCheck = await checkClaims(m, r.text, send);
    } else {
      const fix = await fixRendering(m, levelLabel(level), r.text, r.factCheck, send);
      result.kept = fix.edits.some((e) => e.accepted)
        ? { ...r, ...measureRendering(m, level, length, fix.text), cost: 0, factCheck: fix.factCheck, fix, fixedFrom: r }
        : { ...r, fix };
    }
  } catch (err) {
    if (what === 'check') r.factCheck = { error: err.message };
    else result.kept = { ...r, fix: { error: err.message, edits: [], disputed: [], cost: 0 } };
  } finally {
    checking.delete(key);
    if (resultKey() === key) drawOutput();
  }
}

function progressView(m, job) {
  const length = lengthById(state.length);
  const slow = ['complete', 'none'].includes(length.id);
  const steps = {
    draft: `Reading the full legal text of ${m.label} (${fmt(m.wordCount)} words) and writing a ${levelById(state.level).label} version…`,
    check: `${CHECK_NAME} is checking each claim in the draft against the legal text…`,
    revise: () => `Sending the draft back once with ${job.asks.length} thing${job.asks.length === 1 ? '' : 's'} to fix: ${job.asks.map(shortAsk).join('; ')}.`,
    recheck: `${CHECK_NAME} is checking the revision against the legal text…`,
    fix: () => `Fixing ${job.fixFlags.length} flagged sentence${job.fixFlags.length === 1 ? '' : 's'}: the model edits only those, then ${CHECK_NAME} checks each fix before it is used…`,
  };
  const n = { draft: 1, check: 2, revise: 3, recheck: 4, fix: job.revision ? 5 : 3 }[job.step];
  const step = typeof steps[job.step] === 'function' ? steps[job.step]() : steps[job.step];
  const preview = { recheck: job.revision, check: job.draft, fix: job.fixing }[job.step];
  const previewLabel = job.step === 'fix' ? 'Text being fixed (flagged sentences marked)' : `${job.step === 'recheck' ? 'Revision' : 'Draft'}, not checked yet`;
  return h('article', { class: 'card ai working' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, `${levelById(state.level).label} · ${length.label}`),
      h('span', { class: 'elapsed', id: 'read-elapsed' }, '0.0 s')),
    h('div', { class: 'progress' }, h('span')),
    h('p', {}, h('b', {}, `Step ${n}: `), step),
    h('p', { class: 'small muted' }, slow
      ? 'Complete versions of long measures take 20 to 45 seconds.'
      : 'Writing takes 1 to 5 seconds; each fact check about 5 to 20. You can switch measures or levels meanwhile; this keeps running.'),
    preview && h('div', { class: 'preview' },
      h('p', { class: 'preview-label' }, `${previewLabel} (${preview.words} words, grade ${preview.grade})`),
      h('div', { class: 'ai-text muted-text' }, preview.text.split(/\n{2,}/).map((p) => h('p', {}, highlight(p, flagMarks(job.step === 'fix' ? job.fixFlags : [])))))));
}

function updateElapsed(job) {
  const el = $('read-elapsed');
  if (el) el.textContent = `${((Date.now() - job.started) / 1000).toFixed(1)} s`;
}

/** A few words for each thing the draft was sent back for. */
function shortAsk(ask) {
  if (ask.startsWith('A check against')) return `the fact check flagged “${(ask.match(/: "(.*?)"/) || [])[1] || 'a claim'}”`;
  if (ask.startsWith('It says')) return 'a known misreading';
  if (ask.startsWith('It leaves out')) return `missing: ${ask.split(': ')[1].split('. ')[0]}`;
  return ask.split('. ')[0];
}

// ---- 5c. A finished rendering ---------------------------------------------------------------

function resultView(m, result) {
  if (result.error) {
    return h('div', { class: 'notice bad' }, h('b', {}, 'The model call failed: '), result.error,
      h('p', {}, h('button', { type: 'button', class: 'primary', onclick: () => { results.delete(resultKey()); generate(); } }, 'Try again')));
  }
  const level = levelById(state.level);
  const length = lengthById(state.length);
  const r = result.kept;
  const parts = [result.draft, result.revision].filter(Boolean);
  const base = r.fixedFrom || r; // a Complete version checked on request carries its check here
  const checks = [...new Set([...parts.map((x) => x.factCheck), base.factCheck])].filter((x) => x && !x.error);
  const cost = parts.reduce((n, x) => n + x.cost, 0) + checks.reduce((n, x) => n + x.cost, 0) + (r.fix?.cost || 0);
  const calls = parts.length + checks.reduce((n, x) => n + x.calls.length, 0) + (r.fix?.calls?.length || 0);
  const flagged = r.factCheck?.flagged || [];
  const marks = [...flagMarks(flagged), ...fixMarks(r.fix)];

  return h('article', { class: 'card ai' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, `${level.label} · ${length.label}`),
      h('p', { class: 'provenance' },
        `Written by ${MODEL_NAME} from the full legal text of ${m.label}, not from the official summary. It can leave things out or get them wrong. `,
        h('button', { type: 'button', class: 'linkish', onclick: () => choose({ level: 'as-written' }) }, 'Read the full legal text'),
        ' · ', link(m.sources.legalTextPdf, 'Official PDF'))),
    h('div', { class: 'meters' },
      meter('Words', r.words, length.words ? `target ${length.target}` : 'no length target', wordStatus(m, r, length)),
      meter('Reading grade', r.grade, `Flesch–Kincaid · target ${level.target}`, gradeStatus(r, level)),
      meter('Cost', money(cost), `${calls} call${calls === 1 ? '' : 's'} · ${(result.ms / 1000).toFixed(1)} s`)),
    warnings(m, r),
    h('div', { class: 'ai-text' }, r.text.split(/\n{2,}/).map((p) => h('p', {}, highlight(p, marks)))),
    h('p', { class: 'ai-foot' }, 'AI-generated from the certified text · ', new Date(result.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
    correctionsView(r),
    factCheckView(m, result),
    factList(r),
    processNote(result),
    h('details', { class: 'more' }, h('summary', {}, 'What we sent the model'), promptView(r.messages)),
    h('details', { class: 'more' },
      h('summary', {}, 'Compare with the official summary (never sent to the model)'),
      officialSummary(m)));
}

function wordStatus(m, r, length) {
  if (!length.words) return null;
  const [lo, hi] = length.words;
  if (r.words > hi) return { kind: 'off', text: `${r.words - hi} over` };
  if (r.words < lo) return sourceTooShort(m, length.id) ? { kind: 'note', text: 'short by design' } : { kind: 'off', text: `${lo - r.words} under` };
  return { kind: 'ok', text: 'on target' };
}

function gradeStatus(r, level) {
  if (r.grade == null) return null;
  if (r.grade >= level.grade[1] + 1) return { kind: 'off', text: `${(r.grade - level.grade[1]).toFixed(1)} above` };
  if (r.grade < level.grade[0]) return { kind: 'off', text: `${(level.grade[0] - r.grade).toFixed(1)} below` };
  return { kind: 'ok', text: 'on target' };
}

/** Problems a reader must see before the text: fact-check flags, known misreadings, dropped key facts, cut-off output. */
function warnings(m, r) {
  const flagged = r.factCheck?.flagged || [];
  const contradicted = flagged.filter((f) => f.verdict === 'contradicted').length;
  const unsupported = flagged.length - contradicted;
  const list = [
    ...(contradicted ? [['bad', `The fact check found ${contradicted} claim${contradicted === 1 ? '' : 's'} that may contradict the legal text (marked in red below).`]] : []),
    ...(unsupported ? [['warn', `The fact check could not find ${unsupported} claim${unsupported === 1 ? '' : 's'} in the legal text (marked in orange below).`]] : []),
    ...r.misread.map((x) => ['bad', `This version may say ${x.wrong}. The legal text says ${x.right}.`]),
    ...r.missing.map((fact) => ['warn', `This version does not seem to mention that ${fact}.`]),
  ];
  if (r.finish === 'length') list.push(['bad', 'The model hit its length cap and stopped mid-way. This text is cut off.']);
  if (sourceTooShort(m, state.length) && r.words < lengthById(state.length).words[0]) {
    list.push(['info', `Shorter than asked on purpose: ${m.label}’s legal text is only ${fmt(m.wordCount)} words.`]);
  }
  return list.length ? h('div', { class: 'notices' }, list.map(([kind, text]) => h('p', { class: 'notice ' + kind }, text))) : null;
}

/** Marks for the sentences the fact check flagged. */
function flagMarks(flagged) {
  return flagged.map((f) => ({ text: f.claim, cls: 'flag ' + f.verdict, title: f.reason }));
}

/** Marks for the sentences the final fix rewrote. */
function fixMarks(fix) {
  return (fix?.edits || []).filter((e) => e.accepted && e.replacement)
    .map((e) => ({ text: e.replacement, cls: 'fixed', title: `Corrected after the fact check. It used to say: “${e.original}”` }));
}

/** Wrap each mark's text where it appears in the paragraph (first match; overlaps are skipped). */
function highlight(paragraph, marks) {
  const spans = [];
  for (const m of marks) {
    for (const needle of [m.text.trim(), m.text.trim().replace(/[.!?]$/, '')]) {
      const at = needle.length > 8 ? paragraph.indexOf(needle) : -1;
      if (at >= 0) { spans.push({ at, end: at + needle.length, m }); break; }
    }
  }
  spans.sort((a, b) => a.at - b.at);
  const out = [];
  let pos = 0;
  for (const s of spans) {
    if (s.at < pos) continue;
    out.push(paragraph.slice(pos, s.at), h('mark', { class: s.m.cls, title: s.m.title }, paragraph.slice(s.at, s.end)));
    pos = s.end;
  }
  out.push(paragraph.slice(pos));
  return out;
}

/** What the final fix changed, and what it tried but did not use. */
function correctionsView(r) {
  const fix = r.fix;
  if (!fix) return null;
  if (fix.error) return h('p', { class: 'notice bad' }, 'The final fix failed: ', fix.error);
  const kept = fix.edits.filter((e) => e.accepted);
  const dropped = fix.edits.filter((e) => !e.accepted);
  const summary = kept.length
    ? `${kept.length} sentence${kept.length === 1 ? ' was' : 's were'} corrected after the fact check (marked in green). The model edited only the flagged sentences; everything else is unchanged.`
    : 'The final fix tried to correct the flagged sentences, but no correction passed its own check, so the text is unchanged.';
  return h('div', { class: 'corrections' },
    h('p', { class: 'fc-head' }, 'Final fix ', h('span', { class: 'muted' }, `(${MODEL_NAME} edited, ${CHECK_NAME} re-checked each edit)`)),
    h('p', { class: 'small' }, summary,
      r.fixRejected ? ' The corrected version was not used: it scored worse (for example it dropped a key fact).' : ''),
    h('ul', { class: 'fix-list' }, [...kept, ...dropped].map((e) => h('li', { class: 'fix-item ' + (e.accepted ? 'kept' : 'dropped') },
      h('span', { class: 'fc-verdict' }, e.accepted ? (e.replacement ? 'Corrected' : 'Removed') : 'Not used'),
      h('p', { class: 'fix-before' }, h('del', {}, e.original)),
      e.replacement && h('p', { class: 'fix-after' }, e.accepted ? h('ins', {}, e.replacement) : e.replacement),
      e.note && h('p', { class: 'fc-found' }, e.note)))),
    fix.disputed.length > 0 && h('p', { class: 'small muted' },
      `The fixer judged ${fix.disputed.length} flagged sentence${fix.disputed.length === 1 ? '' : 's'} to be already correct and left ${fix.disputed.length === 1 ? 'it' : 'them'} as written: `,
      fix.disputed.map((d) => `“${d.sentence}”`).join(' ')));
}

const VERDICT_LABEL = { contradicted: 'May contradict the legal text', unsupported: 'Not found in the legal text', unchecked: 'Not checked', supported: 'Matches the legal text' };
const QUOTE_LABEL = {
  exact: '✓ quote found word for word in the legal text',
  partial: '≈ quote partly found in the legal text',
  missing: '⚠ quote not found in the legal text: treat this finding with care',
  none: 'no quote given',
};

function factCheckView(m, result) {
  const r = result.kept;
  const key = resultKey();
  const fc = r.factCheck;
  if (!fc) {
    const est = estimate(m);
    return h('div', { class: 'factcheck' },
      h('p', { class: 'fc-head' }, 'Fact check'),
      h('p', { class: 'small' }, 'Complete versions are not checked automatically: checking every claim of a long text takes a while.'),
      h('button', { type: 'button', class: 'secondary', disabled: checking.has(key), onclick: () => onRequest('check', m, key, result) },
        checking.has(key) ? 'Checking every claim…' : `Check every claim against the legal text (about ${money(est.check * 2)})`));
  }
  if (fc.error) return h('div', { class: 'factcheck' }, h('p', { class: 'notice bad' }, 'The fact check failed: ', fc.error));
  const flagged = fc.flagged;
  // Short versions are fixed automatically; a Complete version checked on request offers it.
  const canFix = flagged.length > 0 && !r.fix && !AUTO_REVISE_LENGTHS.includes(state.length);
  return h('div', { class: 'factcheck' },
    h('p', { class: 'fc-head' }, 'Fact check ',
      h('span', { class: 'muted' }, `(${CHECK_NAME} tested ${fc.claims.length} claim${fc.claims.length === 1 ? '' : 's'} against the legal text; it is a model checking a model, so these are flags for you to look at, not verdicts)`)),
    flagged.length
      ? h('ul', { class: 'fc-list' }, flagged.map((f) => fcItem(f)))
      : h('p', { class: 'small fc-ok' }, r.fix ? '✓ No claim is flagged after the final fix.' : '✓ No claim was flagged.'),
    canFix && h('button', { type: 'button', class: 'secondary', disabled: checking.has(key), onclick: () => onRequest('fix', m, key, result) },
      checking.has(key) ? 'Fixing the flagged sentences…' : `Fix the ${flagged.length} flagged sentence${flagged.length === 1 ? '' : 's'} (each fix is checked again)`),
    h('details', { class: 'more' },
      h('summary', {}, `All ${fc.claims.length} checked claims, with the legal text each one rests on`),
      h('ul', { class: 'fc-list all' }, fc.claims.map((f) => fcItem(f)))));
}

function fcItem(f) {
  return h('li', { class: 'fc-item ' + f.verdict },
    h('span', { class: 'fc-verdict' }, VERDICT_LABEL[f.verdict] || f.verdict, f.fromFix ? ' · re-checked after the final fix' : ''),
    h('p', { class: 'fc-claim' }, '“', f.claim, '”'),
    f.verdict !== 'supported' && h('p', { class: 'fc-reason' }, f.reason),
    f.quote && h('blockquote', { class: 'fc-quote' }, f.quote.replace(/\[(?:NEW|DELETED): /g, '').replace(/\]$/, '')),
    f.quote && h('p', { class: 'fc-found ' + f.quoteFound }, QUOTE_LABEL[f.quoteFound]));
}

function factList(r) {
  if (!r.facts.length) return null;
  return h('div', { class: 'facts' },
    h('p', { class: 'facts-head' }, 'Key facts we look for at this length ', h('span', { class: 'muted' }, '(a word check by our code, no AI; it can miss rewordings)')),
    h('ul', {}, r.facts.map((f) => h('li', { class: f.ok ? 'ok' : 'off' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, f.ok ? '✓' : '✗'),
      h('span', { class: 'sr' }, f.ok ? 'Found: ' : 'Not found: '), f.fact))));
}

function processNote(result) {
  if (!result.revision) {
    return h('p', { class: 'process' }, AUTO_REVISE_LENGTHS.includes(state.length)
      ? 'Checked on the first try (our code and the fact check): nothing to send back.'
      : 'Complete versions are not sent back automatically (a second pass doubles a long wait). The numbers above are as written.');
  }
  const d = result.draft;
  const keptRevision = result.keptRevision;
  const other = keptRevision ? result.draft : result.revision;
  const otherFlags = other.factCheck?.flagged?.length;
  return h('div', { class: 'process' },
    h('p', {}, `The first draft (${d.words} words, grade ${d.grade}) was sent back once: `,
      h('span', { class: 'muted' }, result.asks.map(shortAsk).join('; ')), '. ',
      keptRevision ? 'The revision came out closer to target, so you are reading the revision.'
        : 'The revision came out further from target, so you are reading the first draft.'),
    h('details', { class: 'more' },
      h('summary', {}, `${keptRevision ? 'See the first draft' : 'See the revision we did not use'} (${other.words} words, grade ${other.grade}`
        + `${otherFlags != null ? `, ${otherFlags} fact-check flag${otherFlags === 1 ? '' : 's'}` : ''})`),
      h('div', { class: 'ai-text muted-text' }, other.text.split(/\n{2,}/).map((p) => h('p', {}, highlight(p, flagMarks(other.factCheck?.flagged || [])))))));
}

/** The exact messages, with the long legal text folded so the instructions are readable. */
function promptView(messages) {
  return h('div', { class: 'prompt' }, messages.map((msg) => h('div', { class: 'prompt-msg' },
    h('div', { class: 'prompt-role' }, { system: 'System', user: 'User', assistant: 'Model (its first draft)' }[msg.role]),
    h('pre', {}, msg.content.replace(/<legal_text>\n[\s\S]*?\n<\/legal_text>/, (block) =>
      `<legal_text>\n… the full certified text, ${fmt(countWords(block))} words (see “As written”) …\n</legal_text>`)))));
}

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function officialSummary(m) {
  const fk = fleschKincaid(m.official.summary);
  return h('div', { class: 'official' },
    h('p', { class: 'small muted' }, `Written by the Attorney General. ${fk.words} words · Flesch–Kincaid grade ${fk.grade}. Our app never sends it to a model; it is here so you can check the AI version against it.`),
    h('p', { class: 'official-title' }, m.official.title),
    h('p', {}, m.official.summary),
    h('p', {}, h('b', {}, 'Fiscal impact: '), m.official.fiscalImpact),
    link(m.official.url, 'Official guide page'));
}

// ---- 6. Topics of concern ---------------------------------------------------------------------
// Part 1 is a word count (js/topics.js, no AI). Part 2 asks the model what the measure means for
// one topic; every point quotes the legal text, and the opinion is labeled as an AI opinion.

const topicKey = () => [app.measureId, state.topic, topicLevel(), TOPIC_PROMPT_VERSION].join('|');

/** The reading level for topic explanations: the one picked above, or Everyday for "As written". */
function topicLevel() {
  return state.level === 'as-written' ? 'everyday' : state.level;
}

function drawTopics() {
  const m = measure();
  const counts = countTopics(m);
  $('topics').replaceChildren(...[
    h('div', { class: 'topics-head' },
      h('h2', {}, `Topics of concern: what does ${m.label} touch?`),
      h('p', { class: 'small muted' }, 'From a count of topic words in the legal text, by our code (no AI). A rough first signal, not proof of impact. Pick a topic to look closer.')),
    h('div', { class: 'topic-tiles' }, counts.topics.map((t) => topicTile(t))),
    state.topic && topicPanel(m, counts),
  ].filter(Boolean));
}

function topicTile(t) {
  const bars = { none: 0, low: 1, some: 2, high: 3 }[t.strength.id];
  return h('button', {
    type: 'button', class: 'topic-tile ' + t.strength.id, 'aria-pressed': String(state.topic === t.id),
    onclick: () => choose({ topic: state.topic === t.id ? null : t.id }),
  },
  h('span', { class: 'topic-label' }, t.label),
  h('span', { class: 'signal', role: 'img', 'aria-label': t.strength.label }, [0, 1, 2].map((i) => h('span', { class: i < bars ? 'on' : '' }))),
  h('span', { class: 'topic-strength' }, t.strength.label),
  h('span', { class: 'topic-count' }, `${t.count} mention${t.count === 1 ? '' : 's'} · ${t.per1000} per 1,000 words`),
  h('span', { class: 'topic-words' }, t.top.slice(0, 3).map(([w, n]) => `${w} ×${n}`).join(', ') || 'no topic words'));
}

function topicPanel(m, counts) {
  const t = counts.topics.find((x) => x.id === state.topic);
  const topic = TOPICS.find((x) => x.id === state.topic);
  const left = ['the opening paragraph', ...counts.skipped].join(', ');
  return h('div', { class: 'topic-panel' },
    h('div', { class: 'topic-count-detail' },
      h('h3', {}, t.label, h('span', { class: 'muted' }, ` · ${topic.covers}`)),
      h('p', { class: 'small' }, `Topic words found in ${fmt(counts.words)} words of ${m.label}’s legal text (left out: ${left}):`),
      t.top.length
        ? h('ul', { class: 'chips' }, t.top.map(([w, n]) => h('li', {}, `${w} ×${n}`)))
        : h('p', { class: 'small muted' }, 'None of the topic words appear.'),
      t.count > 0 && h('p', {}, h('button', { type: 'button', class: 'linkish', onclick: () => choose({ level: 'as-written', highlightTopic: t.id }) },
        'Show them in the legal text')),
      h('details', { class: 'more' },
        h('summary', {}, 'Which words we count for this topic'),
        h('p', { class: 'small' }, [...topic.phrases, ...topic.words.split(/\s+/)].join(', ')))),
    topicAiView(m, t, topic));
}

function topicAiView(m, t, topic) {
  const key = topicKey();
  const level = levelById(topicLevel());
  if (topicRuns.has(key)) {
    return h('div', { class: 'card ai working topic-card' },
      h('header', { class: 'card-head' }, h('span', { class: 'badge ai' }, 'AI-generated'),
        h('span', { class: 'card-kind' }, `${m.label} · ${t.label}`)),
      h('div', { class: 'progress' }, h('span')),
      h('p', {}, `Reading the full legal text of ${m.label} for what it says about “${t.label}”… usually 1 to 3 seconds.`));
  }
  const r = topicResults.get(key);
  if (!r) {
    const chars = buildTopicMessages(m, t.id, `${level.label} (${level.target})`).reduce((n, x) => n + x.content.length, 0);
    const est = (chars / 4) * PRICE_PER_TOKEN.input + 600 * PRICE_PER_TOKEN.output;
    return h('div', { class: 'topic-ask' },
      h('button', { type: 'button', class: 'primary', onclick: () => askTopic(m, t, topic) }, `Ask AI what ${m.label} means for “${t.label}”`),
      h('p', { class: 'small muted' }, `One call to ${MODEL_NAME} with the full legal text, about ${money(est)}. Written at the ${level.label} level`
        + `${state.level === 'as-written' ? ' (pick another level above to change it)' : ''}. It quotes the legal text for every point and gives its own opinion, labeled as one.`));
  }
  if (r.error) {
    return h('div', { class: 'notice bad' }, h('b', {}, 'The model call failed: '), r.error, ' ',
      h('button', { type: 'button', class: 'linkish', onclick: () => { topicResults.delete(key); askTopic(m, t, topic); } }, 'Try again'));
  }
  const RELEVANCE = { direct: ['direct', 'The measure’s own rules change this'], indirect: ['indirect', 'Touches this only indirectly'], none: ['none', 'Not about this topic'] };
  const [cls, label] = RELEVANCE[r.relevance] || RELEVANCE.none;
  return h('article', { class: 'card ai topic-card' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, `${m.label} · ${t.label}`),
      h('span', { class: 'relevance ' + cls }, label),
      h('p', { class: 'provenance' }, `Written by ${MODEL_NAME} from the full legal text of ${m.label}, at the ${level.label} level. Each point quotes the legal text, and our code checks that the quote is really there. `,
        h('button', { type: 'button', class: 'linkish', onclick: () => choose({ level: 'as-written', highlightTopic: t.id }) }, 'Read the full legal text'))),
    r.relevanceNote && h('p', { class: 'notice info' }, r.relevanceNote),
    h('h3', { class: 'topic-sub' }, 'What the legal text says about it'),
    r.facts.length
      ? h('ul', { class: 'topic-facts' }, r.facts.map((f) => h('li', { class: 'topic-fact ' + f.source },
        h('p', { class: 'fact-summary' }, f.summary),
        h('blockquote', { class: 'fc-quote' }, f.quote.replace(/\[(?:NEW|DELETED): /g, '').replace(/\]/g, '')),
        h('p', { class: 'fc-found ' + (f.source === 'unverified' ? 'missing' : '') },
          { rules: '✓ quote found in the measure’s own rules', standard: 'quote found, but only in a standard section every initiative has (the opening paragraph or a procedural section), so it does not count as being about this topic', unverified: '⚠ quote not found word for word in the legal text: treat this point with care' }[f.source]))))
      : h('p', {}, 'The legal text says nothing about this topic.'),
    h('div', { class: 'opinion' },
      h('p', { class: 'opinion-label' }, 'AI opinion'),
      h('p', { class: 'opinion-note' }, 'The model’s own view: not a fact from the legal text, and not advice on how to vote.'),
      h('p', { class: 'opinion-text' }, r.opinion)),
    h('p', { class: 'ai-foot' }, `AI-generated · ${money(r.cost)} · ${(r.ms / 1000).toFixed(1)} s · our word count for this topic: ${t.strength.label.toLowerCase()} (${t.count})`),
    h('details', { class: 'more' }, h('summary', {}, 'What we sent the model'), promptView(r.messages)));
}

async function askTopic(m, t, topic) {
  const key = topicKey();
  if (topicRuns.has(key)) return;
  const level = levelById(topicLevel());
  topicRuns.set(key, { started: Date.now() });
  drawTopics();
  const send = async (messages, opts) => {
    const data = await chat(messages, opts);
    addCost(`${m.label} · ${t.label} (topic)`, data.usage?.cost ?? 0, 'read');
    return data;
  };
  try {
    topicResults.set(key, await explainTopic(m, topic.id, `${level.label} (${level.target})`, send));
  } catch (err) {
    topicResults.set(key, { error: err.message });
  } finally {
    topicRuns.delete(key);
    drawTopics();
  }
}

/** Wrap every match of re inside container's text in <mark class="topic-hit">. Returns the marks. */
function markMatches(container, re) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const node of nodes) {
    const text = node.nodeValue;
    const found = [...text.matchAll(re)];
    if (!found.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const f of found) {
      const mark = h('mark', { class: 'topic-hit' }, f[0]);
      frag.append(text.slice(pos, f.index), mark);
      marks.push(mark);
      pos = f.index + f[0].length;
    }
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
  return marks;
}

