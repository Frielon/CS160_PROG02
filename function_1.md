# Functionality 1: a ballot measure at the reader's reading level and length

Design notes for the PROG 02 report. Everything below describes the code as it stands in
`guide.html`, `js/guide.js`, `js/prompts.js`, `js/checker.js` and `js/topics.js`, and every number comes
from a test run saved in `tools/.cache/eval/` (the run name is given in brackets, e.g. [v8-all-x2]).

Functionality 1 has two halves: **reading level × length** (sections 1–9) and **voter topics of concern**
(section 10: a no-AI keyword count per topic, then an AI explanation of one topic with a labeled opinion).

---

## 0. At a glance

| | |
|---|---|
| What it does | Shows one of the four measures as the certified text ("As written", no AI) or as an AI rewrite at one of 3 reading levels × 4 lengths. |
| Models | Rewriting: Gemini 2.5 Flash-Lite. Fact check: Gemini 2.5 Flash (two calls). Final fix: Gemini 2.5 Flash-Lite. |
| Source sent to the model | The measure's full legal text (`fullTextMarked`), never `official.*` (the answer key). |
| Pipeline | Draft → code checks + fact check → one measured revision → re-check → keep the better version → fix the sentences still flagged (each fix re-checked). |
| Reading level hit rate (final prompts, 72 renderings, before fact check) | Plain English 19/24, Everyday 20/24, Simplest 13/24 [v8-all-x2] |
| Length hit rate (same run) | Headline 24/24, Short 19/24, Standard 7/18 (excluding Prop 43, whose 214-word text cannot honestly fill 250 words) [v8-all-x2] |
| Fact check on 22 labeled cases | 16/16 real misreadings caught, 14/16 planted errors caught, 0 false alarms in 12 checks of correct texts [c7, two runs] |
| Final fix on the flagged errors | 15/15 labeled errors corrected, 23/23 edits kept after re-check [f3-lite] |
| Whole pipeline, Prop 40 + 43 (18 renderings) | Renderings with a fact-check flag: 7/18 drafts → 3/18 after revision → **1/18 shown**. Known misreadings shown: 0. Key facts dropped: 0 [fix-e2e] |
| Cost and wait per rendering (whole pipeline) | about $0.010–0.018 on average, up to $0.03; 17–18 s on average, up to 40 s [fix-e2e] |
| Topics of concern | Keyword counts for 5 topics × 4 measures (no AI, free); AI explanation per topic: 20/20 opinions under 80 words, 36/43 quotes found word for word, ≈$0.0001–0.0023 and ≈2 s per call [t3] |
| Total spent on testing functionality 1 | about $2.78 of the $5 key (recorded per call) |

---

## 1. What the reader sees

**Picking.** Four measure cards (label, official title, a bar showing legal-text length). Two radio groups:
reading level (As written · Plain English grade 11–13 · Everyday grade 7–9 · Simplest grade 3–4) and length
(Headline ≤25 words · Short 75–100 · Standard 250–300 · Complete, no cap). A debug checkbox adds
"No length rule" so the reading level can be tested on its own (the handout suggests this).

**Before paying.** The panel shows how many tokens of legal text will be sent and the estimated cost of
writing and of the fact check. Nothing is generated until the reader presses "Rewrite with AI"
(a model call costs money, so it is never fired just by changing a radio button). Results are kept while the
page is open, so switching back to a combination already generated is free.

**As written.** The certified text from the Official Voter Information Guide, drawn with struck-out
(deleted) and italic (new) words, a jump list of sections, word count, Flesch–Kincaid grade, and "$0 / no model".
The length options are disabled with the note: *"As written is always the complete certified text. To shorten it,
a model has to rewrite it: pick a reading level."*

**While it works.** A progress card names the current step (writing, fact-checking, revising, re-checking,
fixing), shows a running timer, and shows the draft as soon as it exists ("not checked yet"), so the reader
can start reading during the 5–20 s fact check.

**An AI rendering card** (violet edge, "AI-generated" badge on every card, every time):
- provenance line: written by Gemini 2.5 Flash-Lite from the full legal text, not the official summary, can be wrong; link to the full legal text (one click) and the official PDF;
- three meters: words vs target, Flesch–Kincaid grade vs target, cost and time of this rendering;
- warnings above the text: fact-check flags, known misreadings, missing key facts, cut-off output, "shorter than asked on purpose";
- the text, with flagged sentences marked (red = may contradict the legal text, orange = not found in it) and corrected sentences marked green (hover shows what it used to say);
- **Final fix** section: each correction as before → after, plus edits that were tried and not used, and why;
- **Fact check** section: each flagged claim with the reason, the quote from the legal text, and whether our code found that quote word for word; a fold-out with every checked claim and the legal text it rests on;
- key-fact checklist (✓/✗, "a word check by our code, no AI");
- what the revision step did ("sent back once: …; you are reading the revision") with the other version available;
- "What we sent the model" (the exact prompts, legal text folded);
- "Compare with the official summary (never sent to the model)".

**Session cost** in the header: running total and number of calls, with a list of every call and its cost (from `usage.cost`).

### Impossible or awkward combinations: what the interface does

| Combination | Decision | Why |
|---|---|---|
| As written + any length | Length disabled, explained | The certified text has one length; shortening it requires a model. |
| Simplest + Headline | Allowed, with a warning before the call: "25 words at a 3rd-grade level will almost certainly drop qualifiers" | The handout's example; we let it run and then check for dropped facts (e.g. "one-time"). |
| Any Headline | Warning: "A 25-word headline leaves most of the measure out" | Honest about what a headline can carry. |
| Prop 43 + Standard (or Short) | The model is told to write less rather than pad; the word meter shows "short by design" | Prop 43's legal text is 214 words; 250–300 words could only be filled with padding or outside facts. |
| Complete on long measures | Notice: "Expect 20 to 45 seconds"; no automatic fact check or revision; buttons to check and to fix on request | A second pass over 3,000–6,000 words doubles a long wait; see §4.4. |

---

## 2. Files, models, and why these models

### Created, changed, and where the API key goes

**Where graders put their API key:** copy `js/config.local.example.js` to **`js/config.local.js`** and paste the OpenRouter key into `OPENROUTER_API_KEY`. That file is listed in `.gitignore`; it is the only place the key is read (by `js/openrouter.js` in the browser, and by the `tools/*.mjs` test scripts, which also accept the `OPENROUTER_API_KEY` environment variable). The key is not in any committed file.

**Files created for functionality 1**

| File | What it is |
|---|---|
| `guide.html`, `js/guide.js`, `css/guide.css` | The voter guide page. `js/guide.js` is its Read a measure tab, functionality 1 (measures, reading level × length, topics of concern); `guide.html` and `css/guide.css` also hold the other two tabs. |
| `js/prompts.js` | Reading levels, lengths, rendering and revision prompts, code checks, scoring, `renderMeasure()` pipeline. |
| `js/checker.js` | Fact check (two calls), quote lookup, final fix. |
| `js/topics.js` | Topics of concern: keyword counts and the one-topic explanation. |
| `js/legal-text.js` | Draws the certified text with its struck-out / new marks (used by the guide and the explorer). |
| `js/dom.js` | Small DOM helpers (`h()`, `fmt()`, `link()`). **Shared**: also used by the guide's other two tabs. |
| `datapack.html`, `js/datapack.js`, `css/datapack.css` | Data pack explorer: every field of `data/datapack.json`, readable (a development aid, no AI). |
| `tools/eval-render.mjs` | Tests rendering: prompts, revision, fact check, final fix. |
| `tools/eval-checker.mjs`, `tools/checker-cases.json` | Tests the fact check on 22 labeled cases. |
| `tools/eval-fix.mjs` | Tests the final fix on saved fact-check flags. |
| `tools/topics-report.mjs`, `tools/eval-topics.mjs` | Topic counts (free); tests the topic explanation. |
| `function_1.md` | This document. |

**Existing files changed**

| File | Change |
|---|---|
| `js/openrouter.js` | Added `chat(messages, { model, maxTokens, temperature, responseFormat })`; `askModel(prompt)` now calls it, so the class examples work as before. **Shared**: the guide's other two tabs also call `chat()`. |
| `README.md` | Added "The voter guide (our app)" section listing these files. |

**Used as given:** `js/fk.js` (Flesch–Kincaid), `data/datapack.json`, `js/config.local.example.js`, `.gitignore` (already ignores `js/config.local.js` and `tools/.cache/`).

**Local only, not committed:** `js/config.local.js` (the key) and `tools/.cache/eval/` (all test results, JSON plus Markdown with every output; the run names in brackets in this document refer to these files).

**Shared by all three tabs:** `js/app.js` loads the pack, switches tabs, and keeps the session cost meter described in section 1.

**Not part of functionality 1:** `compare.html`, `js/compare.js`, `js/compare-view.js`, `css/compare.css`, `office.html`, `js/office.js`, `js/office-page.js`, `css/office.css`, `tools/eval-compare.mjs`, `tools/eval-office.mjs`, `tools/test-office.mjs` belong to functionalities 2 and 3 and are not described here.

### Models

| Step | Model | Why this one (measured) |
|---|---|---|
| Writing | `google/gemini-2.5-flash-lite`, temperature 0.3 | Cheap (≈$0.0003–0.0009 per rendering with revision, [v8-all-x2]) and fast (1.3–2.7 s average). Gemini 2.5 Flash as the writer did **not** remove the key misreading (1/9 Prop 40 drafts vs 2/18 for Flash-Lite) and cost ≈3× more [flash-drafts]. Turning on Flash-Lite's "thinking" doubled cost with no gain [v4-dev-think]. |
| Fact check, both calls | `google/gemini-2.5-flash`, temperature 0, JSON schema | Flash-Lite as checker caught only 8–10 of 16 real misreadings; GPT-4.1 Mini caught 5/8 with more false alarms; Flash caught 16/16 (§5.4). |
| Final fix | `google/gemini-2.5-flash-lite`, temperature 0, JSON schema | It only has to edit a few flagged sentences with the checker's quote in hand; 15/15 fixed [f3-lite]. Every edit is re-checked by Flash anyway. |

---

## 3. The rendering prompt: decisions and the failures behind them

Full text in Appendix A. The prompt is one system message (rules) and one user message (legal text first,
then the task: length, reading level, "no title", and a closing length reminder). Prompt versions v1 → v8 were
tested on the real API; each change below answers a failure we saw.

| Decision | Failure that caused it (version where seen) |
|---|---|
| **Send `fullTextMarked`, not `fullText`.** Explain the marks: [NEW] = added, [DELETED] = removed, unmarked = stays the same or the measure's own titles/findings. | In `fullText` new words are unmarked. Prop 4's remaining ban ("…if the funds are earmarked for education, transportation, or public safety") is new text, and the model dropped it in nearly every Short and Standard rendering (v1–v3). Marked text costs about 2% more tokens. |
| **Length first and repeated at the end**; Headline worded as "your whole reply is a single headline-style summary". | "Headline" was read as a title and the model kept writing: 0/6 headlines in range, up to 270 words (v1). After: 6/6 (v2) and 24/24 (v8). |
| **Ask for a midpoint**, not only a range ("About 90 words (between 75 and 100)"), and give a sentence count computed from the level ("about 7 sentences"). | Drafts undershot ranges; the same 90 words is 4–5 sentences at Plain English and 11+ at Simplest, so one fixed instruction cannot fit all levels. |
| **Sentence length targets lowered** (Plain 18, Everyday 11, Simplest 4–8 words, max 10) plus a short style example for Simplest. | The model writes ~40% longer sentences than asked: Simplest landed around grade 5–6 on Prop 4 (v1–v2), Plain overshot to 13.9 when asked for "precise vocabulary" (v2). |
| **Rule 2: do not describe how the law works today unless the text shows it.** Story rule: "the example must not invent how things work today". | Simplest stories invented a baseline: Prop 43 "Before this rule… Most people had to agree" (wrong: that is not in the text) (v1). |
| **Rule 6: when the text points to another law for an exception, say exceptions apply; do not guess.** | Prop 43 Plain invented "existing rules that allow special taxes if approved by a majority vote" (v1). |
| **Rule 4: never drop a condition** ("not allowed unless X" must not become "not allowed"). | Prop 43 Simplest Complete flipped the measure: "your town cannot ask for a new special tax… even if people vote for it" (v4). |
| **Rule 5: say exactly what a rate applies to.** | Prop 40: "5% of their wealth over $1 billion" (the text taxes the whole net worth; v4–v6). The rule reduced but did not stop it, hence the checks in §4. |
| **Rule 3: no predictions, no goals stated as results.** **Rule 8: findings are the authors' claims.** | "This could lower costs for housing" (Prop 45, v4); "It would help people who are not rich run for office" (Prop 4 purpose stated as fact, v3). |
| **Story rules:** start with "Imagine", build the example only from things the text names and from the kinds of projects/people the measure covers, no made-up numbers. | Prop 4 invented "small donations from at least 100 people" (v3); Prop 45 used "Imagine your town needs a new park" (parks are not an essential project) (v4–v6). |
| **Rule 9: if the text is too short for the length, write less.** | Prop 43 (214 words) cannot fill 250–300 words honestly. |
| **Plain text only, every sentence ends with a period.** | Flesch–Kincaid counts sentences by end punctuation; bullet lists and headings would distort the grade. |
| **Legal text placed first in the user message.** | Repeated calls on the same measure share a prefix, and the provider caches it: over a million cached input tokens per 72-rendering test run, which makes revisions and re-checks cheaper. |
| **Temperature 0.3.** | Fewer surprises between runs; the test set still varies run to run (see §5.3). |

Reading levels are judged the way school grades are read: "grade 7–9" accepts Flesch–Kincaid 7.0 to 9.9.
Flesch–Kincaid only measures sentence and word length, not difficulty of ideas; we show it as a measurement, not as truth.

---

## 4. The check–revision design

### 4.1 The pipeline (`renderMeasure()` in `js/prompts.js`)

```text
 legal text (fullTextMarked) + level + length
        │
        ▼
 1. DRAFT ─────────────── Gemini 2.5 Flash-Lite writes the rendering
        │
        ▼
 2. CHECK (no AI) ─────── words vs range · Flesch–Kincaid grade vs range ·
        │                  key facts this length must keep · known misreadings
        ▼
 3. FACT CHECK ────────── call A (Flash, no legal text): split each sentence into precise single facts
        │                  call B (Flash, with legal text): supported / contradicted / unsupported + quote
        │                  our code: is each quote really in the legal text?
        ▼
 4. ONE REVISION ──────── only if something is off; same conversation (the model still has the legal text);
        │                  feedback lists the measured numbers and each problem with the legal text's quote
        ▼
 5. RE-CHECK + CHOOSE ─── steps 2–3 on the revision; keep whichever of draft / revision scores better
        │
        ▼
 6. FINAL FIX ─────────── only if the kept version still has fact-check flags:
        │                  the model proposes edits to the flagged sentences only; our code applies them;
        │                  each replacement is fact-checked again and kept only if it passes;
        │                  the fixed text replaces the kept one only if it scores no worse
        ▼
 7. SHOW ──────────────── labeled AI card with meters, warnings, highlights, corrections, fact check, prompts
```

Steps 3–6 run automatically for Headline, Short and Standard. For Complete, only steps 1–2 run; the reader
can press "Check every claim" (step 3) and then "Fix the N flagged sentences" (step 6).
"As written" runs none of this.

### 4.2 Step 2 and the revision feedback: our code measures, the model edits

The model cannot count its own words or syllables; our code can. The revision message (Appendix B) gives the
model the **measured** numbers and a concrete target, not a vague "make it simpler":

- **Length:** "It is 12 words too long. Cut it to about 88 words (between 75 and 100): drop minor details first, and keep qualifiers such as 'one-time', 'only' and 'except'."
- **Grade:** we solve the Flesch–Kincaid formula for the sentence length that would land mid-range given the draft's own syllables per word, e.g. "Your sentences average 16.0 words; make them average about 13 words."
- **Grade slack:** grade is only sent back when it is off by more than 0.5. Asked to nudge 6.9 up to 7, the model jumped to 13.6 (v7).
- **Missing key facts:** "It leaves out something the legal text says that a version this long should keep: most of the money (90%) goes to health care."
- **Known misreadings:** "It says that the 5% applies only to wealth above $1 billion, but the legal text says …"
- **Fact-check flags:** each flagged claim with the checker's reason and the legal text's quote.
- **Every revision request restates the word range**, because adding a missing fact used to push Standard past 300 words (v7).

Only **one** revision. A second rarely helped: grade moves in jumps (e.g. 1.4 → 7.1) rather than steps, and each
round adds seconds. The draft is kept if the revision came out further from target.

### 4.3 Choosing between versions: the score

`missScore()` in `js/prompts.js`; 0 is on target, lower wins.

| Problem | Points |
|---|---|
| Fact-check claim "contradicted" | 5 each |
| Known misreading present | 5 each |
| Key fact missing | 3 each |
| Fact-check claim "unsupported" | 2 each |
| Words outside range | 10 × (distance ÷ range limit), e.g. 30 words over 300 = 1.0 |
| Grade outside range | 1 per grade level off |

Meaning first: a version that hits 250–300 words but drops "one-time" loses to one that is 10 words short and keeps it.

### 4.4 Step 3: the fact check (`checkClaims()`)

**Why two calls.** One call that both read the claim and checked it failed in two ways we could see in its output (c1–c3):
1. It found the right passage ("the tax imposed is 5 percent of the net worth") and still matched surface words: "the rewrite says 5%, the text says 5 percent → supported" for "5% of their wealth over $1 billion".
2. Asked to state a claim's meaning after quoting the legal text, it read the claim through the legal text and repaired it: "your town cannot ask for a new special tax" became, in its own reading, "…unless approved by two-thirds", then "supported".

So **call A never sees the legal text**: it only turns each sentence into precise single facts ("The 5% is charged on only the part of net worth above $1 billion"). **Call B never sees the original wording**: it checks those facts against the legal text. Call A keeps lists together ("only A, B or C" is one fact) and carries "today"/"except"/"unless" into every fact, because splitting them produced false facts (c5–c6).

**Quotes are checked by code.** For every verdict the checker must copy a quote from the legal text. Our code
normalizes both (marks, curly quotes, spacing) and looks the quote up, accepting "A … B" quotes when every piece of
three or more words is there in order. The UI shows "✓ quote found word for word" or "⚠ quote not found: treat this finding with care".
In the final checker runs, 469 of 501 checked facts (about 94%) carried a quote found word for word.

**How it is presented.** As flags, not verdicts: "it is a model checking a model, so these are flags for you to look at".

### 4.5 Step 6: the final fix (`fixFlagged()`, `fixRendering()`)

The fixer does **not** rewrite the text. It returns JSON edits, one per flagged sentence (`original` →
`replacement`, or an empty replacement to delete), and **our code applies them by position**. So:
- every sentence that was not flagged stays word for word (a guarantee a free rewrite cannot give);
- an edit that changes more than two sentences (the flagged one and, at most, the opening of its made-up example) is refused;
- every replacement is fact-checked again; an edit is kept only if its replacement passes (or turns a contradiction into a milder "not found");
- the fixed text replaces the kept version only if its score is no worse (so deleting a key fact to silence a nitpick loses);
- the fixer is told the word range and the current count, to prefer the shortest correct wording, to drop a minor detail before a qualifier, and to add no describing words the legal text does not use;
- the fixer may leave a sentence unchanged if it judges the flag wrong ("disputed"); the UI says so.

---

## 5. Performance

### 5.1 How it was tested

- **Rendering:** `tools/eval-render.mjs` runs the same `renderMeasure()` as the page for chosen measures × levels × lengths × runs and scores every output with the code checks; with `--fact-check` and `--final-fix` it runs the whole pipeline. We also read the outputs: the code checks find length, grade and known problems, not new kinds of error.
- **Fact check:** `tools/eval-checker.mjs` on 22 labeled cases in `tools/checker-cases.json`: 8 *real* misreadings our renderer produced during testing, 8 errors *planted* into correct texts (exact ground truth), and 6 *correct* texts (any flag is a false alarm), one of them worded right next to the Prop 40 error ("people with a net worth of $1 billion or more … pay 5% of their net worth"). A labeled error counts as caught only if the checker flags the claim that holds it.
- **Final fix:** `tools/eval-fix.mjs` feeds the checker's saved flags into the fixer (so the input is fixed and only the fixer varies) and reports whether each labeled error's sentence was corrected; every edit was also read by a person, because grading the fixer only with the same checker would be circular.
- Samples are small (9–72 renderings per run, 22 checker cases). Rates are indications, not precise estimates.

### 5.2 Rendering prompt versions (Prop 4 and 43 for v1–v3, all four measures from v4; numbers after the one revision from v3 on)

| Version | Plain grade in range | Everyday | Simplest | Length in range* | Main change |
|---|---|---|---|---|---|
| v1 [v1-dev] | 5/8 | 7/8 | 2/8 | 5/18 | first prompts; headlines 0/6 |
| v2 [v2-dev] | 4/8 | 6/8 | 2/8 | 11/15 | length first and repeated; grounding rules |
| v3 [v3-dev] | 7/8 | 8/8 | 5/8 | 12/15 | marked text; sentence targets; measured revision |
| v4 [v4-all] | 13/16 | 11/16 | 9/16 | 30/33 | keep the better of draft/revision |
| v5 [v5-all] | 10/16 | 16/16 | 9/16 | 29/33 | conditions, rates, predictions; grade solved from FK |
| v6 [v6-all-x2] | 17/24 | 20/24 | 13/24 | 56/66 | missing key facts sent back; no auto-revision for Complete |
| v7 [v7-all-x2] | 15/24 | 20/24 | 16/24 | 53/66 | known misreadings sent back |
| **v8** [v8-all-x2] | **19/24** | **20/24** | **13/24** | 50/68 | grade slack 0.5; range restated; Standard as 4 × 70 words |

\*Headline/Short/Standard, not counting Prop 43 renderings that are short only because its text is short.

### 5.3 Final rendering quality without the fact check [v8-all-x2, 72 renderings; v8-complete, 12]

| Length | Words in range | Key facts dropped | Known misreadings |
|---|---|---|---|
| Headline | 24/24 | 3/24 | 0 |
| Short | 19/24 | 0/24 | 0 |
| Standard | 7/18 (+6 Prop 43 short by design) | 1/24 | 1 |
| Complete (no revision) | no target | 2/12 | 0; grade in range 8/12 |

Most Standard misses are within about 10% (220–250 or 300–335 words): the model's length precision is about ±15%, the
band is ±9%. Simplest is the least reliable on grade: the same prompt lands near grade 2 on Prop 40 (short words:
tax, money, rich) and near 5 on Prop 4 (candidate, campaign, election).

### 5.4 Fact-check versions [22 labeled cases]

| Version | Design | Real misreadings caught | Planted caught | Flags on correct texts | Per check |
|---|---|---|---|---|---|
| c1, Flash-Lite ×2 | one call | 10/16 (**Prop 40: 0/6**) | 16/16 | 0/10 | $0.001 |
| c1, Flash ×1 | one call | 4/8 | 7/8 | 0/5 | $0.006 |
| c2, Flash-Lite ×2 | + "judge the likely reading" | 8/16 | 16/16 | 0/12 | $0.001 |
| c3, Flash-Lite ×2 | + meaning before quote | 7/16 | 16/16 | 0/12 | $0.001 |
| c4, Flash-Lite ×2 | two calls (meaning, then verify) | 10/16 | 16/16 | 4/12 | $0.001 |
| c5, Flash-Lite ×2 | + single facts | 8/16 | 14/16 | 0/12 | $0.001 |
| c5, Flash verifier ×1 | | 6/8 | 7/8 | 1/6 | $0.008 |
| c5, GPT-4.1 Mini verifier ×1 | | 5/8 | 6/8 | 2/6 | $0.004 |
| c6, Flash verifier ×2 | + lists kept together, rate wording | 14/16 | 14/16 | 3/12 | $0.007 |
| **c7, Flash for both calls ×2** | + "today/except/unless" kept in every fact | **16/16** | **14/16** | **0/12** | **$0.008, ~9 s** |

The only miss in c7 (both runs) is the planted outside-knowledge sentence "it applies to cities, counties, and
special districts". On texts that also contain errors, c7 raised a few extra flags: about half were real problems
(a definition not in the legal text, two wrong statements about property taxes), about half nitpicks
("This is called an ad valorem tax"; "Ten percent is for education and food assistance").

**A catch nobody listed:** in the pipeline test the checker flagged a Prop 40 draft saying the tax covers
"real estate". The legal text says "All interests in any real property held directly by a taxpayer … shall not be
included in net worth." That error was on no hand-written list.

### 5.5 Final fix versions [15 labeled errors the checker had flagged]

| Version | Errors corrected | Edits kept after re-check | What we fixed next |
|---|---|---|---|
| f1 [f1-lite] | 14/15 | 22/23 | headline grew 22 → 39 words; accurate sentences deleted on nitpicks |
| f2 [f2-lite] | 15/15 | 22/23 | length limit given; may dispute a flag; may fix an example's opening sentence. Headline still 33 words; one paragraph-wide edit |
| **f3** [f3-lite] | **15/15** | **23/23** | drop details before qualifiers; no new describing words; code refuses edits that change >2 sentences. Headline fixed in 22 words |

Examples of f3 corrections (all re-checked as supported):
- "…a one-time 5% tax on California billionaires' net worth over $1 billion…" → "…a one-time tax of up to 5% on California billionaires' net worth…" (22 words, within the headline limit)
- "The tax is 5% of a billionaire's net worth above $1 billion." → "The tax is 5% of a billionaire's net worth, with a reduction for those with net worth below $1.1 billion."
- "This is true even if people vote for it." (Prop 43) → "This is true unless the tax is approved by a two-thirds vote."
- "Imagine your town needs a new park. This rule makes it faster to build parks." (Prop 45) → "This rule makes it faster to build needed projects."
- "Before this rule, your town could vote to tax everyone a little bit." (Prop 43, invented) → deleted.

The re-check also stops bad fixes: in the pipeline test the fixer "corrected" "The town is a local government." by adding
"…a city, county, or other local government body" (outside knowledge); the re-check flagged it, and the original sentence stayed (still flagged).

### 5.6 The whole pipeline [fix-e2e: Prop 40 and 43 × 3 levels × Headline/Short/Standard = 18 renderings]

| Stage | Renderings with any fact-check flag |
|---|---|
| First drafts | 7/18 |
| After the one revision (and choosing) | 3/18 |
| **After the final fix: what the reader sees** | **1/18** |

Known misreadings: 1 in the drafts, 0 shown. Key facts dropped in what is shown: 0/18. The final fix ran on 3
renderings and was used on 2. In an earlier run without the final fix [fc-prop40, Prop 40 only]: 3/9 drafts flagged → 1/9 shown.

**The trade-off we accept:** in this run grade was in range for Plain 3/6, Everyday 4/6, Simplest 2/6, lower than
without the fact check (v8: 19/24, 20/24, 13/24). With the score in §4.3 a contradiction outweighs a missed grade, so
revisions driven by fact-check flags win even when they read a grade off. The sample is small; the direction is by design.

### 5.7 Alternatives tried and rejected

| Alternative | Result | Decision |
|---|---|---|
| Flash-Lite "thinking" (1,024-token budget) for writing [v4-dev-think] | Cost $0.0109 → $0.0208 for 24 renderings; Simplest grade 6/8 → 4/8; length 13/15 → 12/15 | Off |
| Gemini 2.5 Flash as the writer [flash-drafts, 18 drafts] | Prop 40: misreading 1/9 (Flash-Lite 2/18), any contradiction 2/9 (Flash-Lite 4/18). Prop 43: no contradictions but more outside definitions (5/9 flagged "unsupported"). Writing ≈3× the cost; slower | Keep Flash-Lite and catch errors with the pipeline |
| One-call fact check (any model) | Missed every real Prop 40 misreading on Flash-Lite (0/6) | Two calls |
| Flash-Lite or GPT-4.1 Mini as fact checker | 8/16 and 5/8 real misreadings; more false alarms | Gemini 2.5 Flash |
| Automatic revision of Complete versions | Doubles a 20–45 s wait; revisions of 5,000-word texts over-corrected grade (a 5,938-word Prop 40 version went from grade 14.0 to 9.4) | Manual check/fix buttons instead |
| A second automatic revision | Grade jumps past the target instead of converging | One revision, keep the better |

### 5.8 Cost and waiting time per rendering (measured)

| Setup | Prop 4 | Prop 43 | Prop 40 | Prop 45 |
|---|---|---|---|---|
| Write + code checks + 1 revision [v8-all-x2] | $0.0003, 2.1 s | $0.0003, 1.3 s | $0.0008, 2.6 s | $0.0009, 2.7 s |
| Complete, no revision [v8-complete] | $0.0005, 4.0 s | $0.0002, 1.1 s | $0.0019, 12.6 s (max 19 s) | $0.0024, 15.9 s (max 24 s) |
| **Whole pipeline** (fact check + revision + final fix) [fix-e2e] | — | $0.010, 17.6 s (max 35 s) | $0.018, 17.5 s (max 40 s) | — |

The fact check is most of the cost (Gemini 2.5 Flash reads the whole legal text, about $0.003–0.012 per check).
The provider caches the legal text across calls on the same measure, which keeps revisions and re-checks cheap.
The full testing for functionality 1 cost about $2.71 (sum of `usage.cost` over all recorded test calls).

---

## 6. Failure log (what a model got wrong, and what the interface does now)

| # | What the model did | Measure / step | How the app handles it now |
|---|---|---|---|
| 1 | "Headline" read as a title; kept writing up to 270 words | all / writing (v1) | Length stated first and last; headlines 24/24 in range |
| 2 | Invented how the law works today: "Before this rule… Most people had to agree" | Prop 43 / writing | Rule 2; fact check flags "unsupported"; final fix deleted those sentences |
| 3 | Invented a rule: special taxes "approved by a majority vote" | Prop 43 / writing | Rule 6; fact check flags it; final fix deleted it |
| 4 | Dropped the remaining ban on earmarked education/transportation/public-safety funds | Prop 4 / writing | Send marked text; key-fact check → revision restores it; warning if still missing |
| 5 | Flipped the measure: "cannot ask for a new special tax… even if people vote for it" | Prop 43 / writing | Rule 4; key-fact "two-thirds" check; fact check "contradicted"; final fix → "unless … two-thirds vote" |
| 6 | "5% of their wealth over $1 billion" (the text taxes the whole net worth) | Prop 40 / writing, both Flash-Lite and Flash | Rule 5; known-misreading check (now also "one billion" wording); fact check; final fix → "up to 5% … net worth" |
| 7 | Invented a number: "small donations from at least 100 people" | Prop 4 / Simplest story | Story rule; fact check flags it; final fix → "a specified number of people" |
| 8 | Wrong example: "Imagine your town needs a new park" | Prop 45 / Simplest story | Story rule (example must be a kind the measure covers); known-misreading check; fact check; final fix |
| 9 | Predictions and goals as results: "This could lower costs", "It would help people who are not rich run for office" | Prop 45, Prop 4 / writing | Rules 3 and 8; fact check flags them "unsupported" |
| 10 | Said the tax covers "real estate" (directly held real property is excluded) | Prop 40 / writing | Caught by the fact check from the legal text alone; revision/final fix |
| 11 | Outside knowledge: "applies to cities, counties, and special districts" | Prop 43 / writing | **Not reliably caught** (missed by the checker in both test runs); provenance line warns that the text can be wrong |
| 12 | The checker itself read ambiguous wording charitably and passed the Prop 40 error | fact check (c1–c3) | Two-call design: meaning written without the legal text, then verified |
| 13 | The checker split "only A, B or C" into "only A", "only B"… and flagged correct text | fact check (c5) | Call A keeps lists together |
| 14 | The fixer made a headline 39 words long | final fix (f1) | Word range in the fix prompt; shortest correct wording; now 22 words |
| 15 | The fixer added outside knowledge to a fix ("a city, county, or other local government body") | final fix | Every replacement is re-checked; this one was refused and the original stayed flagged |
| 16 | Asked to raise grade 6.9 to 7, the model jumped to 13.6 | revision (v7) | Grade only sent back when off by more than 0.5; target sentence length computed from FK |
| 17 | Called a tax measure "direct" for My Vote because of the standard opening paragraph and the conflicting-measures clause, even when told not to | Prop 40 / topic explanation (t1–t3) | Code checks where each quote comes from; without a quote from the measure's own rules the app shows "none" and says why |
| 18 | Stretched a topic with no topic words: "could make it harder to fund … roads or environmental projects" | Prop 43 My Neighborhood / topic explanation (t1) | Strict relevance definitions and "do not stretch"; now "none" (t2, t3) |
| 19 | Paraphrased the legal text inside a "quote" ("The Legislature may appropriate…" for "shall have the authority to appropriate…") | topic explanation | Code looks every quote up; the point is shown with "⚠ quote not found word for word" |

---

## 7. Material for the report's summary check

The official summary (`official.summary`) is shown to readers for comparison but never sent to a model.

**Prop 40, our Everyday Standard rendering after the whole pipeline** [fix-e2e; 220 words, grade 8.0, no fact-check flags]:

> This measure would create a one-time 5% tax on the net worth of California billionaires. This tax would apply to individuals and trusts with a net worth of $1 billion or more. The tax would be calculated based on net worth as of December 31, 2026. Taxpayers could choose to pay the tax in five equal yearly installments, with a 7.5% annual charge on the unpaid balance.
>
> The tax revenue would go into a special fund. 90% of the money would be for health care programs, like Medi-Cal. 10% would be for education and food assistance programs, like CalFresh. The Legislature could spend up to $22.5 billion annually on health care and $2.5 billion annually on education and food assistance from this fund.
>
> The measure defines "net worth" as the value of all assets minus debts. It lists specific rules for valuing assets like stocks, businesses, and real estate. It also provides an optional deferral account for taxpayers who would face liquidity issues paying the tax.
>
> The measure also specifies rules for how the tax is applied and collected. It allows for expedited court review of the law's validity. It states that if this measure conflicts with another measure on the same ballot that taxes billionaire net worth, this measure would prevail if it receives more votes.

**Official summary** (Attorney General; Flesch–Kincaid grade 12.4):

> Imposes 5% tax on certain taxpayers with assets over $1 billion; revenue primarily for health care. Exempts revenues from constitutional requirements for school funding and spending limit.

Official title: "IMPOSES ONE-TIME TAX ON CERTAIN TAXPAYERS. INITIATIVE CONSTITUTIONAL AMENDMENT AND STATUTE."

Where they diverge (observations from our runs):
- **Dropped provision (ours):** the official summary's second sentence (revenues exempt from the school-funding guarantee and the spending limit) is missing from this rendering, and only 5 of 15 of our Standard/Complete Prop 40 renderings mention it. It is not on our key-fact list, so no check sends it back.
- **"One-time":** the official summary sentence does not say "one-time" (only the title does); every Prop 40 rendering in the final runs kept it.
- **"Assets" vs "net worth":** the official summary says "assets over $1 billion"; the legal text taxes net worth (assets minus debts) of people worth $1 billion or more. Ours follows the legal text.
- **More detail, no money estimate:** ours adds installments, the 90/10 split and the yearly spending caps, but never states costs or revenue, because the fiscal estimate is not in the legal text (rule 1). The official fiscal impact comes from the Legislative Analyst.
- **Reading level:** official summaries score grade 13.9 (Prop 4), 18.2 (Prop 43), 12.4 (Prop 40) and 24.4 (Prop 45): above our Plain English band.

**Prop 4** is the clearest "dropped provision" example: the official summary's second sentence ("Public funding programs may not use funds earmarked for education, transportation, or public safety") was missing from nearly every Short/Standard rendering until we sent the marked text and added it as a key fact that triggers the revision.

---

## 8. Limitations and open items

- Topics of concern: the keyword lists are ours and imperfect (e.g. "election" also means a taxpayer's choice in Prop 40); counts favor long, repetitive texts, which is why we also show the rate per 1,000 words; the opinion is a model's opinion and can lean on outside reasoning.
- The fact check misses some outside knowledge (finding 11) and raises some nitpicks; the fixer rarely disputes a nitpick, so a few accurate sentences ("This is an ad valorem tax") get deleted.
- One unsupported word survives: a Simplest fix wrote "a **small** reduction" for those under $1.1 billion; the re-check passed it.
- When the fixer's edit fails its re-check, the original sentence stays, flagged but not corrected.
- Key facts (Appendix E.1) and known misreadings (E.2) are written by hand for these four measures; for a new measure they would be empty and the app would say nothing about them. The fact check and all rules work for any measure.
- Accuracy is weighted above reading level and length (§4.3), so grade hit rates drop when the fact check drives the revision.
- Small samples; outputs vary between runs even at temperature 0.3.
- Flesch–Kincaid measures sentence and word length only.
- Waiting: 17–18 s on average, up to 40 s, for a fully checked rendering; the draft is shown while the check runs.

---

## 9. How to reproduce

```bash
python3 -m http.server 8000     # then open http://localhost:8000/guide.html (key in js/config.local.js)

node tools/eval-render.mjs --dry                                                     # prompt sizes, free
node tools/eval-render.mjs --measures all --lengths headline,short,standard --runs 2 --revise --tag v8
node tools/eval-render.mjs --measures prop-40,prop-43 --lengths headline,short,standard \
     --revise --fact-check --final-fix --tag fix-e2e                                 # whole pipeline
node tools/eval-checker.mjs --models google/gemini-2.5-flash --meaning-model google/gemini-2.5-flash --tag c7
node tools/eval-fix.mjs --from c7-flashA-flashB --tag f3
node tools/topics-report.mjs                                                         # topic counts, free
node tools/topics-report.mjs --context prop-40 vote                                  # every match in context
node tools/eval-topics.mjs --tag t3                                                  # topic explanations, 20 calls
node tools/eval-topics.mjs --resettle t3                                             # re-apply the relevance rule, free
```

Results (JSON, plus Markdown with every output) are written to `tools/.cache/eval/`.

---

## 10. Voter topics of concern (the second half of functionality 1)

### 10.1 What the reader sees

Under the measure cards, a strip of five tiles, one per topic from the handout. Each tile shows a 3-bar signal
meter, a label (Not mentioned · Mentioned · Some focus · Strong focus), the number of mentions and the rate per
1,000 words, and the top matched words. Clicking a tile opens a panel:

- **Left (no AI):** every topic word found, with counts, what was left out of the count, a fold-out with the full keyword list, and **"Show them in the legal text"**, which switches to As written and highlights every match (with "Jump to the first").
- **Right (AI):** **"Ask AI what Prop N means for 'Topic'"**, with the cost before the call (≈$0.0001–0.0027). The answer card is labeled AI-generated and shows: a relevance chip (The measure's own rules change this · Touches this only indirectly · Not about this topic), up to 3 points each with its quote from the legal text and whether our code found that quote, and a dashed **AI OPINION** box that says every time: "The model's own view: not a fact from the legal text, and not advice on how to vote." Cost, time and the exact prompt are shown under it.

The chosen topic stays selected when the reader switches measures, so a voter can step through all four measures for "My Home". The explanation is written at the reading level picked above (Everyday when "As written" is selected).

### 10.2 Part 1: the word count (no AI)

**What we count.** Whole words in any case, plus a few two-word phrases that are counted before their parts ("health care" counts once, not as "health" + "care"). We count the proposed law itself:
- the guide's standard opening paragraph ("This initiative measure is submitted to the people…") is left out;
- standard procedural sections every initiative carries are left out (Conflicts / Conflicting Measures, Liberal Construction, Legal Defense, Proponent Standing, Severability, Effective Date), because they talk about ballots and votes without being about your vote;
- deleted (struck-out) words are counted: what a measure takes away is part of what it changes.

**Keyword lists** (`TOPICS` in `js/topics.js`). The handout's example list for My Home is used as given, plus a few owning-cost terms.

| Topic | What it covers (handout) | Words counted (whole words, any case) | Phrases (counted before their parts) |
|---|---|---|---|
| My Taxes | Taxes and spending, such as how public money is spent | tax, taxes, taxed, taxing, taxation, taxable, taxpayer, taxpayers, excise, levy, levies, revenue, revenues, fund, funds, funding, funded, budget, budgets, appropriated, appropriation, appropriations, moneys | general fund, public funds, public money, public moneys, special fund |
| My Home | Rent and housing costs, renting and owning | housing, home, homes, homeowner, homeowners, homeownership, mortgage, mortgages, rent, rents, rental, rentals, renter, renters, tenant, tenants, landlord, landlords, residential, apartment, apartments, dwelling, dwellings, eviction, evictions, homeless, homelessness | real property, property tax, property taxes, affordable housing |
| My Health and Schools | Your health, and help for families and schools | health, healthcare, medical, medi-cal, medicare, hospital, hospitals, clinic, clinics, patient, patients, physician, physicians, doctor, doctors, nurse, nurses, school, schools, education, educational, student, students, teacher, teachers, college, colleges, university, universities, child, children, families, family, food, nutrition, calfresh, snap, meal, meals | health care, public health, child care, mental health |
| My Neighborhood | Local services and the environment, including water and roads | water, wastewater, sewer, sewers, road, roads, street, streets, highway, highways, bridge, bridges, transit, transportation, traffic, park, parks, environment, environmental, pollution, climate, wildfire, wildfires, fire, fires, firefighter, firefighters, police, library, libraries, infrastructure, broadband, electricity, energy, utility, utilities | drinking water, public safety, open space, air quality, clean energy, local services |
| My Vote and My Say | Elections and your vote | vote, votes, voter, voters, voted, electorate, election, elections, elective, elected, ballot, ballots, candidate, candidates, campaign, campaigns, initiative, initiatives, referendum | — |

**Words we removed after reading every match in context** (`node tools/topics-report.mjs --context <measure> <topic>`):
- "appropriate": mostly the adjective ("culturally appropriate measures"), 5 false hits in Prop 45 alone; we keep "appropriated" and "appropriation(s)";
- "contribution(s)", "donor(s)": in Prop 40 these are charitable contributions, not campaign money;
- "voting": in Prop 40 it is "voting or other direct control rights" of a business.

Kept despite noise, and visible to the reader in the matched-word list: "election" (Prop 40 uses it 3 times for a taxpayer's choice), "vote" in "rollcall vote" (the Legislature), "firefighters" in Prop 40's findings.

**Strength.** Raw counts favor long texts (Prop 40 has 12,419 counted words, Prop 43 has 169), so the label comes from mentions per 1,000 words: 0 → Not mentioned; under 2 → Mentioned; 2 to 8 → Some focus; 8 or more → Strong focus. The tile shows both the count and the rate.

**Result** (`node tools/topics-report.mjs`):

| Measure (words counted) | My Taxes | My Home | My Health and Schools | My Neighborhood | My Vote and My Say |
|---|---|---|---|---|---|
| Prop 4 (1,754) | **Strong focus**: 32 (18.2/1k)<br>public funds 9, funds 8, funded 5 | **Not mentioned**: 0 (0/1k)<br>— | **Mentioned**: 1 (0.6/1k)<br>education 1 | **Mentioned**: 2 (1.1/1k)<br>transportation 1, public safety 1 | **Strong focus**: 59 (33.6/1k)<br>candidate 21, candidates 10, election 6 |
| Prop 43 (169) | **Strong focus**: 4 (23.7/1k)<br>tax 3, taxes 1 | **Some focus**: 1 (5.9/1k)<br>real property 1 | **Not mentioned**: 0 (0/1k)<br>— | **Not mentioned**: 0 (0/1k)<br>— | **Strong focus**: 6 (35.5/1k)<br>electorate 3, initiative 2, vote 1 |
| Prop 40 (12,419) | **Strong focus**: 522 (42/1k)<br>tax 189, taxpayer 122, fund 35 | **Mentioned**: 7 (0.6/1k)<br>real property 5, property tax 1, housing 1 | **Strong focus**: 140 (11.3/1k)<br>education 22, health care 21, food 21 | **Mentioned**: 3 (0.2/1k)<br>firefighters 2, infrastructure 1 | **Mentioned**: 6 (0.5/1k)<br>election 3, voters 2, vote 1 |
| Prop 45 (13,635) | **Mentioned**: 3 (0.2/1k)<br>taxpayers 2, taxpayer 1 | **Some focus**: 69 (5.1/1k)<br>housing 37, residential 19, home 2 | **Some focus**: 70 (5.1/1k)<br>health 9, education 7, public health 6 | **Strong focus**: 190 (13.9/1k)<br>environmental 63, water 18, public safety 15 | **Mentioned**: 2 (0.1/1k)<br>elected 1, vote 1 |

Left out of the count: Prop 4: the opening paragraph; Prop 43: the opening paragraph; Prop 40: the opening paragraph, SEC. 8. Conflicts, SEC. 9. Proponent Standing; Prop 45: the opening paragraph, SEC. 2. Conflicting Measures, SEC. 3. Liberal Construction, SEC. 4. Legal Defense.

The counts match what the measures are about: Prop 4 is about elections and public money; Prop 43 about local taxes, voters' power to raise them, and (one mention) taxes on real property; Prop 40 about taxes and health care, schools and food programs; Prop 45 about the environment and local projects, with housing and health/education facilities among its "essential projects". One mention in Prop 43's 169 words already counts as "Some focus"; for very short texts the rate is jumpy, which is why the count is shown next to it.

### 10.3 Part 2: what the measure means for one topic (one model call)

**Call.** Gemini 2.5 Flash-Lite, temperature 0.3, JSON schema, the measure's full legal text (`fullTextMarked`, never the official summary), the topic and its description, our keyword hits (as "a rough signal only"), and the reading level. Prompt in Appendix F. It returns:
- `facts`: at most 3 points, each a `quote` (one continuous passage copied word for word) and a `summary` at the reading level;
- `opinion`: at most 80 words, good / bad / mixed for a voter who cares about this topic and why, naming the trade-off, never telling the voter how to vote;
- `relevance`: direct / indirect / none, with strict definitions (own rules change the topic / only findings, purpose, a list or money that could reach it / nothing).
Gemini writes JSON properties alphabetically, so the facts (quote before summary) come before the opinion.

**Checks by our code (no AI):**
1. **Every quote is looked up** in the legal text (`verifyQuote` in `js/checker.js`): with the struck-out words, and also as the law would read if passed, because quotes of amended law often skip deleted words ("public ~~moneys~~ funds"). Quotes with "…" count when every piece of three or more words is there in order. The reader sees ✓ or "⚠ quote not found word for word: treat this point with care".
2. **Where the quote comes from:** the measure's own rules, or only the opening paragraph / a procedural section (the same parts the word count leaves out).
3. **Relevance is settled by code:** a "direct" or "indirect" reading needs at least one fact quoted, word for word, from the measure's own rules. Otherwise the app shows "Not about this topic" and says: *"The AI said 'direct', but none of its points quotes the measure's own rules word for word, so we show 'none'."*

### 10.4 How it was tested and what changed [t1 → t3; 4 measures × 5 topics = 20 calls each, Everyday]

| Version | Change | Quotes found word for word | Over-claimed relevance (our reading) | Cost, time |
|---|---|---|---|---|
| t1 | first prompt | 45/56 (49/56 after the verifier fix) | 5: Prop 4 Health and Schools and Neighborhood "direct" from one earmark clause; Prop 43 Neighborhood "direct" with no topic words; Prop 40 Vote and Prop 45 Vote "direct" from the opening paragraph | $0.024, 1.9 s |
| t2 | strict relevance definitions, "do not stretch", max 3 facts, quotes with nothing added | 39/45 | 1 clear case left: Prop 40 Vote "direct" (its own opinion said it "does not appear to directly change how voters cast their ballots") | $0.022, 1.9 s |
| t3 | "decide relevance from your own facts"; never use the opening paragraph, the enacting clause or the conflicting-measures section as election facts; one continuous passage per quote | 36/43 | Prop 40 Vote still "direct" (quotes: opening paragraph, conflicts section, one paraphrase) → fixed by the code rule in 10.3, live in the app | $0.021, 1.7 s |

Every opinion in every run was under 80 words (20/20 each run). The cases with no topic words came back with no facts and an opinion saying so, e.g. Prop 4 · My Home: *"This measure does not appear to directly affect your home, renting, or owning. The text focuses on campaign finance and election rules, not housing costs or regulations."*

**Relevance shown after the code rule** [t3 re-settled, `--resettle t3`]: direct for Prop 4 (Taxes, Neighborhood, Vote), Prop 43 (Taxes, Home, Vote), Prop 40 (Taxes, Health and Schools), Prop 45 (Home, Health and Schools, Neighborhood); indirect for Prop 4 Health and Schools, Prop 40 Home and Neighborhood, Prop 45 Taxes; none for Prop 4 Home, Prop 43 Health and Schools and Neighborhood, Prop 40 Vote (changed by the rule), Prop 45 Vote.

**Where the keyword signal and the AI agree and disagree.** All seven "Strong focus" topics came back "direct", and all three "Not mentioned" topics came back "none". Among "Mentioned" topics, one came back "direct" with a quote from the measure's rules (Prop 4 Neighborhood: funds earmarked for transportation or public safety cannot pay for campaigns), and Prop 40 Vote was claimed "direct" by the AI and set to "none" by the code rule. The tile and the AI chip are both shown, so a reader sees when the two signals differ.

**Example** (Prop 43 · My Home, t3, both quotes found):
- "Local governments cannot place a tax based on property value on real estate, unless it follows specific rules in another part of the constitution."
- "Starting January 1, 2027, local governments need a two-thirds vote from the public to approve any new special taxes, or to extend or raise existing ones, with some exceptions."
- AI opinion: "This measure could affect homeowners and renters by limiting the ability of local governments to raise taxes that might be passed on to residents. However, it also requires a high threshold of public approval for new special taxes, which could make it harder to fund local services that benefit homeowners and renters."

### 10.5 Why this design

- **The count is code, not AI**, as the handout asks: free, instant, the same every time, and every number can be traced to the highlighted words in the legal text.
- **The AI explanation quotes, and code checks the quotes**, instead of running the full two-call fact check (§4.4): a topic answer is short and cheap (≈$0.002 for the long measures), and a quote lookup catches invented support for free. Paraphrased "quotes" are shown with a warning, not hidden.
- **The opinion is separated and labeled every time**, in its own dashed box, written after the facts.
- **Relevance is decided by evidence, not by the model's say-so**: the model's own label was the least reliable part (t1–t3), so code requires a verified quote from the measure's rules.

### 10.6 Limits

- The keyword lists are ours; they miss synonyms and catch some noise (shown to the reader in the word list).
- Counts measure how much a text talks about a topic, not how much it affects a voter.
- Opinions can lean on reasoning beyond the text (e.g. that special taxes "could make it harder to fund local services"); they are labeled as opinion, not checked as fact.
- In t3, 5 of 43 points had quotes not found in the legal text and 2 were only partly found (paraphrases); the app marks them, it does not drop them.

---

## Appendix A. Rendering prompt (version v8, model google/gemini-2.5-flash-lite, temperature 0.3)

### A.1 System prompt (same for every rendering)

```text
You rewrite California ballot measures so that voters can understand them. You translate; you do not comment.

Rules:
1. Use only the legal text you are given. Do not add facts, numbers, dates, history or context that are not in it. If the text does not say something (for example, what the measure will cost), do not guess.
2. Do not describe what the law is today, or how things work now, unless the legal text itself shows it (for example in [DELETED: ...] text).
3. Stay neutral. No opinions, no advice on how to vote, and no words that judge the measure (such as "fair", "harmful" or "important"). Do not predict effects (for example "this could lower costs") and do not state goals as results; you may write "the measure says its goal is ...".
4. Keep the qualifiers that change the meaning: one-time, temporary, only, at least, up to, except, unless, start dates, dollar amounts, percentages, vote thresholds, and who is covered. Say both what the measure allows or requires and the limits or exclusions it sets. Never drop a condition: "not allowed unless X" must not become "not allowed", and "allowed only if X" must not become "allowed".
5. When a rate, limit or rule applies to an amount, say exactly what it applies to (for example the whole amount, or only the part above a line), as the text says.
6. When the text makes an exception by pointing to another law (for example "except as provided in Section 4"), say that some exceptions apply. Do not guess what they are.
7. The legal text marks changes. Words inside [NEW: ...] are added by this measure. Words inside [DELETED: ...] are current law that this measure would remove: describe them as something the measure takes away or ends, never as something it does. Unmarked words are either current law that stays the same or the measure's own titles, findings and instructions. The [NEW: ...] and [DELETED: ...] parts are usually what a voter most needs to know, and limits or exceptions inside [NEW: ...] text are part of what the measure does: include them even in a short version.
8. "Findings and declarations" and purpose sections are the authors' claims, not rules. Do not repeat them as facts. If you mention them, say "the measure says".
9. If the legal text is too short to fill the requested length without repeating yourself or adding outside facts, write less.
10. Write plain text only: no headings, no bullet points, no numbered lists, no bold, no markdown. Separate paragraphs with a blank line. End every sentence with a period, question mark or exclamation mark.
```

### A.2 Reading-level instructions

**Plain English** (target grade 11–13; sentence length the length rule assumes: 18 words)

```text
Write like a newspaper editorial for adult readers. Sentences average about 18 words.
Keep the legal and technical terms that matter (for example "special tax" or "environmental impact report"),
and define each one in plain words the first time you use it.
```

**Everyday** (target grade 7–9; sentence length the length rule assumes: 11 words)

```text
Write for a middle-school reader (grade 7 to 9). Sentences average about 11 words, and none is longer than 18 words.
Use common, everyday words. Explain every legal or technical idea in everyday words. Leave nothing undefined.
```

**Simplest** (target grade 3–4; sentence length the length rule assumes: 7 words)

```text
Write for a third- or fourth-grade reader (about 9 years old). One idea per sentence. Most sentences have 4 to 8 words; none has more than 10.
Use short, common words a 9-year-old knows. Swap long words for short ones: "people running for office" for "candidates",
"the state" or "the city" for "government", "money" for "funds" or "revenue", "rule" for "regulation", "vote" for "election".
Keep the key facts: who it affects, what changes, the numbers, and words like "one time" or "only".
This is the sentence style to copy (the topic is different on purpose): "The library has a new rule. Kids can take home ten books. Before, it was five. The rule starts in June."
```

Added for Simplest at every length except Headline:

```text
Tell it as a short story with a made-up, everyday example (a family, a neighborhood, a town) that shows what the measure would change.
Start the story with "Imagine". The example may only show what the legal text says; it must not invent how things work today.
Build the example only from people, places and things the legal text itself names. If the measure covers only certain kinds of projects,
people or places, the example must be one of those kinds. Do not make up numbers, amounts or dates for it.
Say what the measure does, not what its authors hope it will do.
```

### A.3 Length instructions (each pair: the rule near the top of the task, and the reminder that closes the prompt)

| Length | Level | Rule | Closing reminder |
|---|---|---|---|
| Headline | Plain English | Headline. Your whole reply is a single headline-style summary of 25 words or fewer (one sentence). Nothing before it and nothing after it. | Your whole reply must be 25 words or fewer. |
| Headline | Everyday | Headline. Your whole reply is a single headline-style summary of 25 words or fewer (one or two sentences). Nothing before it and nothing after it. | Your whole reply must be 25 words or fewer. |
| Headline | Simplest | Headline. Your whole reply is a single headline-style summary of 25 words or fewer (two or three very short sentences). Nothing before it and nothing after it. | Your whole reply must be 25 words or fewer. |
| Short | Plain English | Short. About 90 words in total (between 75 and 100), in one paragraph (about 5 sentences). | Your whole reply must be between 75 and 100 words. |
| Short | Everyday | Short. About 90 words in total (between 75 and 100), in one paragraph (about 8 sentences). | Your whole reply must be between 75 and 100 words. |
| Short | Simplest | Short. About 90 words in total (between 75 and 100), in one paragraph (about 13 sentences). | Your whole reply must be between 75 and 100 words. |
| Standard | Plain English | Standard. About 280 words in total (between 250 and 300): 4 paragraphs of about 70 words each (about 16 sentences in all). Cover what the measure does, who it affects, any money involved as the text states it, and when it takes effect. | Your whole reply must be between 250 and 300 words, unless the legal text is too short to fill that honestly. |
| Standard | Everyday | Standard. About 280 words in total (between 250 and 300): 4 paragraphs of about 70 words each (about 25 sentences in all). Cover what the measure does, who it affects, any money involved as the text states it, and when it takes effect. | Your whole reply must be between 250 and 300 words, unless the legal text is too short to fill that honestly. |
| Standard | Simplest | Standard. About 280 words in total (between 250 and 300): 4 paragraphs of about 70 words each (about 40 sentences in all). Cover what the measure does, who it affects, any money involved as the text states it, and when it takes effect. | Your whole reply must be between 250 and 300 words, unless the legal text is too short to fill that honestly. |
| Complete | Plain English | Complete. No word limit. Cover every provision of the measure, in the order the text presents them. Leave nothing out, including technical and procedural sections, but say each thing only once. | Cover every provision; there is no word limit. |
| Complete | Everyday | Complete. No word limit. Cover every provision of the measure, in the order the text presents them. Leave nothing out, including technical and procedural sections, but say each thing only once. | Cover every provision; there is no word limit. |
| Complete | Simplest | Complete. No word limit. Cover every provision of the measure, in the order the text presents them. Leave nothing out, including technical and procedural sections, but say each thing only once. | Cover every provision; there is no word limit. |

### A.4 Full user message, example: Prop 40, Everyday, Short

```text
Here is the full legal text of Prop 40, a measure on the California ballot for November 3, 2026. It is 12690 words long.

<legal_text>
… the measure’s full fullTextMarked (12,690 words for Prop 40) …
</legal_text>

Task: rewrite Prop 40 for a voter.

1. Length: Short. About 90 words in total (between 75 and 100), in one paragraph (about 8 sentences).

2. Reading level: Everyday (grade 7–9). Write for a middle-school reader (grade 7 to 9). Sentences average about 11 words, and none is longer than 18 words.
Use common, everyday words. Explain every legal or technical idea in everyday words. Leave nothing undefined.

3. Start directly with the rewrite: no title, and no introduction such as "Here is".

Your whole reply must be between 75 and 100 words.
```

## Appendix B. Revision turn (the same conversation continues)

The first two messages are A.1 and A.4, then the model’s own draft as an assistant message, then this feedback. Example built from a Prop 40 Everyday Short draft that was 112 words, 7 sentences, grade 10.9, missing one key fact, with one known misreading and one fact-check flag:

```text
Our checker measured your rewrite: 112 words, 7 sentences (about 16.0 words per sentence), Flesch-Kincaid grade 10.9.
The target is 75–100 words at Everyday (grade 7–9).

It says that the 5% applies only to wealth above $1 billion, but the legal text says that the tax is 5% of a person’s whole net worth, not just the part above $1 billion (with a lower rate for people worth between $1 billion and $1.1 billion). Fix that.
A check against the legal text found that this claim contradicts the legal text: "The tax is 5% of a billionaire’s net worth above $1 billion." The legal text applies the 5% to the whole net worth, with a reduction below $1.1 billion. The legal text says: "the tax imposed is 5 percent of the net worth of such individual or trust" Fix it or leave it out.
It leaves out something the legal text says that a version this long should keep: most of the money (90%) goes to health care. Add it, in words that fit the reading level.
It is 12 words too long. Cut it to about 88 words (between 75 and 100): drop minor details first, and keep qualifiers such as "one-time", "only" and "except".
It reads above the target grade. Your sentences average 16.0 words; make them average about 13 words by splitting long ones. Keep the words themselves about as simple as they are.

Rewrite it. Keep every fact and qualifier it has now, add nothing that is not in the legal text, and follow all the earlier instructions. The whole rewrite must stay between 75 and 100 words. Reply with the new rewrite only.
```

## Appendix C. Fact check (version c7; call A google/gemini-2.5-flash, call B google/gemini-2.5-flash, temperature 0, JSON schema output)

### C.1 Call A system prompt: spell out what each claim says (no legal text)

```text
You restate claims precisely. You will get a plain-language rewrite of a California ballot measure.

Split it into its claims (usually one per sentence; split a sentence that makes two separate claims). Skip sentences that only set up a made-up example and say nothing about the measure (such as "Imagine a family that needs help."), but keep what the example says the measure does.

For each claim, write its meaning as one or more facts. Each fact is one short sentence stating a single thing the claim's words say to an ordinary voter, spelled out precisely (who is covered, what exactly a number or rate applies to, when, under what conditions). A claim that says three separate things becomes three facts. But never split a list: "It applies only to A, B and C" stays one fact, because "It applies only to A" alone would be false. Every fact keeps the claim's time frame and conditions: if the claim is about today's law ("today", "currently", "right now") or has an "except" or "unless", each of its facts says so too.

When a fact involves a rate or percentage, say exactly what it is charged on, in the form "The X% is charged on ...". Follow the claim's own words: "X% of [an amount] over [a line]" becomes "The X% is charged on only the part of [the amount] above [the line]", while "X% of the [amount] of people with over [a line]" becomes "The X% is charged on the whole [amount] of people above [the line]". Do not add any condition or exception the claim leaves out: a claim that something "cannot" happen, with no "unless", means it can never happen. In everyday English, "X% of [an amount] above (or over) [a line]" means X% of only the part above the line. If a sentence could be read two ways, give the reading most voters would take.
```

Call A user message:

```text
<rewrite>
(the rendering)
</rewrite>

List the claims in this rewrite and the facts each one states.
```

Call A returns `{ "claims": [ { "claim": "...", "facts": ["...", "..."] } ] }`.

### C.2 Call B system prompt: check each fact against the legal text

```text
You check numbered statements about a California ballot measure against the measure's full legal text. You are strict about meaning and neutral about politics.

For each statement decide:
- "supported": the legal text says this. A simpler paraphrase is fine if the meaning is the same.
- "contradicted": the legal text says something different. Look hard at numbers and percentages, what a rate or limit applies to (for example the whole amount, or only the part above a line), who is covered, start dates, one-time versus ongoing, and conditions such as "unless", "only" and "except".
- "unsupported": the legal text does not say this: outside facts, invented numbers, claims about how the law works today that the text does not show, or predicted effects stated as fact. A number, threshold or rule the legal text does not state (for example a vote requirement) is "unsupported" even when the text refers to other laws.

Notes:
- Text inside [DELETED: ...] is current law that the measure removes. Text inside [NEW: ...] is added by the measure.
- Judge each statement exactly as written. Do not excuse it by reading in conditions or details it does not state.
- A statement credited to the measure's own findings or purpose ("the measure says...") is supported if those sections say it. The same statement as plain fact is "unsupported".

For every statement, copy a quote of at most 40 words, word for word, from the legal text: the passage that supports or contradicts it (for "unsupported", the closest relevant passage, or "" if there is none). Give a one-sentence reason.
```

Call B user message (example):

```text
Here is the full legal text of Prop 40.

<legal_text>
… the measure’s full fullTextMarked (12,690 words for Prop 40) …
</legal_text>

Check each of these statements about Prop 40 against the legal text.

1. The 5% is charged on only the part of net worth above $1 billion.
2. The tax is collected one time.
```

Call B returns `{ "checks": [ { "id": 1, "quote": "...", "reason": "...", "verdict": "supported | contradicted | unsupported" } ] }`. Gemini writes JSON properties in alphabetical order, so the quote and reason are written before the verdict.

## Appendix D. Final fix (version f3, model google/gemini-2.5-flash-lite, temperature 0, JSON schema output)

### D.1 System prompt

```text
You correct sentences in a plain-language rewrite of a California ballot measure so that they match the measure's legal text. A fact check has flagged some claims in the rewrite. For each flagged claim, return one edit:
- "original": the whole sentence from the rewrite that contains the flagged claim, copied character for character so that it can be found and replaced.
- "replacement": a corrected sentence that says what the legal text actually says. Use the fact check's reason and quote, and the legal text itself. Keep the same reading level and about the same length; it may be a few words longer only when a needed qualifier requires it ("only", "unless", "one-time", what a rate applies to). Add nothing the legal text does not say.

If the flagged claim has no basis in the legal text at all (an outside fact or an invented detail), drop that part: return the sentence without it, or an empty replacement if nothing true would be left.
If several flagged claims are in the same sentence, return one edit for that sentence that fixes all of them.
The fact check can be wrong. If a flagged sentence is already a fair plain-language reading of the legal text (for example it correctly names a term the legal text uses), return it unchanged as the replacement.
Do not change sentences that have no flagged claim, with one exception: if a fix would leave the sentence that sets it up wrong (for example the opening of a made-up example, "Imagine your town needs a new park"), edit that sentence too, as a separate edit.
Respect the length limit you are given: prefer the shortest correct wording (for example "5% of their whole net worth") over adding detail. When space is tight, drop a less important detail from the sentence (such as what the money is for) before you drop a qualifier. Add no describing words the legal text does not use (such as "small" or "large"). Text inside [DELETED: ...] in the legal text is current law the measure removes; text inside [NEW: ...] is added by the measure.
```

### D.2 User message (example)

```text
Here is the full legal text of Prop 40.

<legal_text>
… the measure’s full fullTextMarked (12,690 words for Prop 40) …
</legal_text>

Here is a plain-language rewrite of it, written at the Everyday (grade 7–9) reading level.

<rewrite>
(the rendering)
</rewrite>

It is 2 words long. After your edits the whole rewrite must still be between 75 and 100 words.

The fact check flagged these claims:
1. "The tax is 5% of a billionaire’s net worth above $1 billion.": contradicts the legal text. Why: The legal text applies the 5% to the whole net worth, with a reduction below $1.1 billion. The legal text says: "the tax imposed is 5 percent of the net worth of such individual or trust"

Return the edits.
```

Returns `{ "edits": [ { "id": 1, "original": "...", "replacement": "..." } ] }`; our code applies the edits.

## Appendix E. Hand-written checks (no AI)

### E.1 Key facts a rendering should keep, by measure and the shortest length that must keep it

| Measure | Fact | From length |
|---|---|---|
| prop-4 | it is about public money for election campaigns | headline |
| prop-4 | money set aside for education, transportation or public safety cannot be used | short |
| prop-43 | new local special taxes need a two-thirds vote | headline |
| prop-43 | it includes taxes that voters propose themselves (initiatives) | short |
| prop-43 | it starts January 1, 2027 | standard |
| prop-40 | the tax is one-time | headline |
| prop-40 | it only applies to people worth more than $1 billion | headline |
| prop-40 | the tax is 5% of net worth | short |
| prop-40 | most of the money (90%) goes to health care | short |
| prop-40 | it can be paid in five yearly installments | standard |
| prop-45 | it changes environmental review | headline |
| prop-45 | it covers "essential" projects such as housing, water, energy and transportation | short |
| prop-45 | it sets deadlines for that review | short |
| prop-45 | it changes how court challenges (lawsuits) work | standard |

### E.2 Known misreadings (seen in testing; each “right” is written from the legal text)

| Measure | Wrong | Right |
|---|---|---|
| prop-40 | that the 5% applies only to wealth above $1 billion | that the tax is 5% of a person’s whole net worth, not just the part above $1 billion (with a lower rate for people worth between $1 billion and $1.1 billion) |
| prop-45 | that it covers parks | that it covers only essential housing, clean energy, water, public health, public safety, broadband, education facility and transportation projects |

## Appendix F. Topic explanation prompt (version t3, model google/gemini-2.5-flash-lite, temperature 0.3, JSON schema output)

### F.1 System prompt

```text
You explain what one California ballot measure means for one topic a voter cares about, using only the measure's legal text. You are neutral about politics.

Reply in JSON with three parts:
1. "facts": at most 3 things the legal text says about this topic itself, most important first. Each has a "quote" (one continuous passage copied from the legal text, word for word, at most 40 words: no section headings, no joining of separate passages, nothing added before or after) and a "summary" (one or two sentences, at the reading level you are given). Keep the qualifiers that change the meaning: one-time, only, unless, except, amounts and dates. The measure's findings and purpose sections are its authors' claims, so write "the measure says" for them. Do not stretch: if you would have to explain why a fact matters for this topic, it is not about this topic. A word appearing once in a list is not an effect. If the legal text says nothing about this topic, give no facts.
2. "opinion": your own view, in at most 80 words, of whether this measure looks good, bad or mixed for a voter who cares about this topic, and why. Base it only on the facts above, name the trade-off where there is one, and never tell the voter how to vote. If the text says nothing about the topic, say the measure does not seem to affect it.
3. "relevance":
   - "direct": the measure's own rules change something a voter would notice in this topic (who pays a tax, rent or housing rules, money for health care or schools, local services, how elections or voting work).
   - "indirect": the topic appears only in the findings or purpose, in a list, or the measure changes money or rules that could later affect it.
   - "none": the text says nothing about it.
   Decide this last, from your own facts: if none of your facts is one of the measure's rules that changes this topic, it is not "direct", and if you have no facts, it is "none".
   Never use the standard opening paragraph ("This initiative measure is submitted to the people…"), the line "The people of California do enact as follows", or a section about conflicting measures on the same ballot as facts about elections: every initiative has them. Findings and purpose alone never make a topic "direct".

Text inside [DELETED: ...] is current law that the measure removes; text inside [NEW: ...] is added by the measure.
```

### F.2 User message (example: Prop 45, My Home, Everyday)

```text
Here is the full legal text of Prop 45, a measure on the California ballot for November 3, 2026.

<legal_text>
… the measure’s full fullTextMarked …
</legal_text>

Topic: "My Home" (Rent and housing costs, renting and owning).
Our keyword count found 69 topic words in the text (housing ×37, residential ×19, home ×2, rents ×2, mortgages ×2, real property ×2, affordable housing ×1, homeowners ×1). That is only a rough signal; read the text itself.

Explain what Prop 45 means for this topic. Write the summaries at the Everyday (grade 7–9) reading level.
```

Returns `{ "facts": [ { "quote": "...", "summary": "..." } ], "opinion": "...", "relevance": "direct | indirect | none" }` (at most 3 facts). Gemini writes properties alphabetically, so the facts come before the opinion and each quote before its summary.
