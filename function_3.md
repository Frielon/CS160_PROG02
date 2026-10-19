# Functionality 3: explain a down-ballot office and illustrate it

The handout asks for this: the user picks one of five down-ballot offices and sees a grounded explanation of what it controls and, just as importantly, what it does not, plus a generated illustration of something the office affects.

This document covers how it was designed, how it was tested, what went wrong along the way, and which files make it up.

Open it at **http://localhost:8000/guide.html#offices**, the guide's Down-ballot offices tab (`office.html` opens it too), after serving the folder (`python3 -m http.server 8000`). The API key goes in `js/config.local.js`, as for the rest of the guide.

---

## 1. What the user sees

1. **Five office buttons.** Picking one shows a card titled **From the data pack**: exactly what `data/datapack.json` says about that office, with numbered facts. This card is never generated and costs nothing.
2. **Explain with AI**: one call to Gemini 2.5 Flash-Lite, about $0.0002–0.0005 and 1–2 seconds. It returns an **AI-generated** card with these parts:
   - a title and a short everyday summary
   - **What it decides**, one item per decision
   - **What it does not decide**, each item tagged with where the limit comes from
   - **About this seat**
   - **Questions the data pack does not answer**

   Every line ends with a tag (F1, B1, or another office's name) for the fact it came from. Hovering a tag highlights that fact in the data-pack card. Below the explanation are the results of our checks and the exact prompt that was sent.
3. **Draw an illustration**: two calls, about $0.039 and 8–10 seconds. Flash-Lite picks one of two scenes we wrote for the office, and Gemini 2.5 Flash Image draws it.
   - The caption names the scene and the data-pack words it illustrates.
   - "Draw another" always picks a scene that hasn't been shown yet.
   - "Download" saves the original image.
4. **Session cost** (top right) lists every call with the cost OpenRouter reported. It is the guide's one meter, shared by all three tabs, so one browser tab shows one total.

Everything the AI writes or draws carries an "AI-generated" badge, every time.

---

## 2. Design principles

| From the handout | How this design answers it |
|---|---|
| The model is never the source of facts. | The model sees only the office's facts from the pack, and every line it writes must cite one. Our code checks the reply for names and numbers it was never given. |
| "What the office does not control is the harder half … exactly the kind of thing a model will invent confidently." | "Does not decide" may only come from three sources, all traceable to the pack (section 3.2). Claims like "that's the City Council" are forbidden in the prompt and caught by our checks. |
| Ask the AI to choose among a set of images so they are not always the same. | Our code offers two random scenes from a menu we wrote, and Flash-Lite picks one. We measured that this varies far more than letting the AI choose from the whole menu (section 5.2). |
| No real people, nothing that could be mistaken for election material. | Every image prompt carries the same rules (section 5.3). An AI reviewer in the test harness looks for real-looking people, text, logos and election imagery. |
| Generated content labeled every time; traceable to its source. | Badges on every AI card and image, fact tags on every line, and a caption naming the pack words each picture shows. The prompts are viewable on the page. |

---

## 3. The explanation (text)

**Model:** `google/gemini-2.5-flash-lite`, temperature 0.3, at most 1,500 output tokens, with a strict JSON schema.

### 3.1 What the model is given: numbered facts

`officeFacts()` turns the pack's entry for an office into numbered facts:

- **F1, F2, …**: the sentences of the description, plus any extra facts (for example AC Transit's short term ending in December 2028).
- **B1, …**: limits the pack states outright (`kind: "boundary"`). There are two in the pack: AC Transit "has nothing to do with BART's" fares, and Peralta has "no authority whatsoever over UC Berkeley".
- **O1, …**: offices a voter could mix this one up with, with their own limits.

**Design decision: only show the model offices a voter could confuse.** We chose these by hand and stored them in `OFFICE_DESIGN[...].neighbors`. The only pair is AC Transit ↔ BART, since both are transit boards with fares. In the first version the model saw all four other offices, and it filled "does not decide" with every one of them ("the Rent Board does not set water rates"). That was true and useless. Offices with no neighbor (Rent Board, EBMUD, Peralta) now have to find their limits in their own facts.

Here is what the model receives for AC Transit (the user message from `buildOfficeMessages()`):

```
Office: AC Transit Director, Ward 1
Area: Alameda-Contra Costa Transit District

What the data pack says about this office:
F1. Bus routes, fares and service levels across the East Bay, including the lines running past campus.
F2. The seat on this ballot is a short term filling an unexpired term that ends in December 2028.
F3. The board is midway through converting from five wards plus two at-large seats to seven wards after a California Voting Rights Act challenge.

The decisions these facts name (give each its own item in decides): bus routes; fares; service levels.

Limits the data pack states (each one must appear in doesNotDecide):
B1. This board sets AC Transit fares and has nothing to do with BART's.

Offices on this ballot that voters mix up with this one (use them only to say what this office does not decide):
O1. BART Director (San Francisco Bay Area Rapid Transit District): Capital spending, fares, service hours and policing policy for the regional rail system.

Explain this office to a voter.
```

### 3.2 What "does not decide" may contain

Each item has a `kind`, and only three kinds are allowed:

| kind | Comes from | Example | Tag on the page |
|---|---|---|---|
| `limit` | a B fact (a limit the pack states). Every B fact must appear. | "This board has nothing to do with BART's fares." | Stated in the pack |
| `other-office` | something the pack gives to a neighbor office, which must be named | "Capital spending, fares, service hours and policing policy for the regional rail system are decided by the BART Director, not by this office." | Another office decides |
| `coverage` | a limiting word in the office's own facts, such as "most" | "It only decides these matters for most rental units in Berkeley, not all of them." | From the pack's wording |

Two things are forbidden.

- **Claiming the office lacks some power the pack never mentions** ("it does not handle parking", "that's up to the city council"). The pack cannot back that up. The handout's own example output makes exactly this mistake ("that's the Planning Commission").
- **Turning a place into a boundary.** "Across the East Bay" does not mean "nowhere else". AC Transit in fact runs buses to San Francisco.

### 3.3 Explain, don't copy

Early versions were perfectly grounded but only copied the pack ("Water rates for most of the East Bay."). Prompt v7 fixes that four ways:

- **One item per decision.** `OFFICE_DESIGN[...].powers` lists the decisions each description names, in the pack's own words (for example `bus routes; fares; service levels`). The prompt asks for one `decides` item each. Without this list, three of the five offices lumped everything into a single line and explained none of it.
- **What it means.** Each item says what the office decides and what that means for people, as long as the meaning follows from the words themselves ("a ceiling is a maximum"), not from how the model thinks the office works. The prompt's examples use a made-up library board, so they don't prime any real office.
- **Open questions instead of guesses.** Things a voter would want to know that the pack doesn't say, such as how many members the board has or how long a term is, go in `openQuestions`. This gives the model somewhere honest to put what it doesn't know.
- **Reading level of grade 9 or below,** measured with Flesch–Kincaid by our code. We first aimed for the guide's "Everyday" band of grade 7–9. Simpler is fine for a single explainer, so the check only flags text at grade 10 or above.

### 3.4 Structured output: how the reply becomes sections

The model can only answer in JSON. `explainOffice()` sends `response_format: { type: "json_schema", json_schema: officeSchema(...) }` with `strict: true`. Every section is a required field, so none can silently go missing. Each item's `facts` list may only contain this office's real fact numbers, which the schema enforces as an `enum`.

Gemini writes properties in alphabetical order, so each item's citation (`facts`) comes before its sentence (`text`): the model cites first, then writes.

`officeJson()` parses the reply with `JSON.parse`; a ```` ```json ```` wrapper is tolerated, and anything else is an error the page shows with "Try again". `explanationCard()` in `js/office-page.js` then maps each field to a section:

| JSON field | On the page |
|---|---|
| `title` | the heading |
| `summary` | the "Imagine…" paragraph |
| `decides[]` | **What it decides** |
| `doesNotDecide[]` | **What it does not decide**, with `kind` as a tag |
| `aboutTheSeat[]` | **About this seat** (left out when empty) |
| `openQuestions[]` | **Questions the data pack does not answer** |
| each item's `facts[]` | the small F1 / B1 / office-name tags |

A real reply, trimmed:

```json
{
  "aboutTheSeat":  [{ "facts": ["F2"], "text": "This is a short term to fill an unexpired term that ends in December 2028." }],
  "decides":       [{ "facts": ["F1"], "text": "Fares are decided, which means the cost to ride the buses." }],
  "doesNotDecide": [{ "facts": ["B1"], "kind": "limit", "text": "This board has nothing to do with BART's fares." }],
  "openQuestions": ["How many members are on the board?", "What are the specific boundaries of Ward 1?"],
  "summary": "Imagine you need to take the bus to campus. The AC Transit Director for Ward 1 helps decide the bus routes, how much you pay to ride, and how often the buses run.",
  "title": "AC Transit Director, Ward 1: Bus routes, fares, service"
}
```

### 3.5 The system prompt (version o7)

This is `OFFICE_SYSTEM_PROMPT` in `js/office.js`, which is the source of truth if this copy ever drifts.

```
You explain local elected offices to voters in Berkeley, California, for a nonpartisan class voter guide. You explain; you never advise.

You get numbered facts about one office from the guide's data pack. They are your only source.

Your job is to make those facts easy to picture. Explain, do not copy: say what each thing the office decides means in everyday life, and explain any term a voter might not know (for example, a library board that sets "branch hours" decides when each branch is open). Explaining what a word means is not adding a fact.

Rules:
1. Use only these facts. Do not add powers, duties, numbers, dates, names, places, history, reasons or examples that they do not state, even if you believe they are true. When a voter would want to know something the facts do not say (how many members the board has, how long a term is, what a fee costs), do not guess: put it in openQuestions.
2. Never name a person, candidate, party, agency, board, council, school, city or group that the facts do not name.
3. Stay neutral: no opinions, no advice on how to vote, and no words that judge, such as "important", "crucial", "powerful", "fair" or "best". Describe what the office decides, not whether that is good.
4. decides: one item for each thing the office decides, from its F facts; never lump a list into one item. Each item says what it decides and what that means for people, in everyday words (for example: "It sets branch hours, which decide when each library branch is open."). What it means must follow from the words themselves (a ceiling is a maximum), not from how you think the office works. Keep the facts' limiting words, such as "most".
5. doesNotDecide is the harder half, and voters need it most. Each item must be one of these kinds:
   - "limit": a B fact, a limit the data pack states. Every B fact must be here.
   - "other-office": something the facts give to one of the offices voters mix up with this one (the O facts). Name that office, and say the decision is its, not this office's (for example: "Park hours are set by the parks board, not by this office."). One item per office, not one per decision.
   - "coverage": only when the office's own facts use a limiting word such as "most" or "only": say what that word leaves out ("most" means not all). A place the facts mention is not a limit: "across the East Bay" does not mean "nowhere else", so never write that the office does nothing outside a place.
   Never claim the office lacks some other power the facts do not mention (such as "it does not handle parking" or "that is up to the city council"): the facts cannot back that up. Write only as many items as the facts support, even if that is one, and never pad.
6. Cite: every item lists the facts it comes from, such as ["F1"], ["B1"] or ["F1", "O1"]. Fact numbers go only in that list, never in the text.
7. Write for an everyday adult reader, at grade 9 or below: full sentences in common words, no fragments.
```

To print the full prompts for any office for free: `node tools/eval-office.mjs --dry --offices <id>`.

---

## 4. Checks on every reply (no AI)

`checkOfficeExplanation()` runs on the parsed reply before anyone sees it. These are word matches: they flag things, and a person decides. A **rule break** (`bad`) appears in red at the top of the card; a **worth a look** (`warn`) item appears in the check list.

| Check | Level | Catches |
|---|---|---|
| Pack limits kept | rule break | an explanation of AC Transit or Peralta that drops its B fact (BART fares, UC Berkeley) |
| Leaks | rule break | a `decides` item that claims a stated limit, or another office's subject, as this office's decision ("sets bus and BART fares", "also sets water rates") |
| Citations | rule break | no citation, an unknown fact number, citing another office for a decision, or an `other-office` limit that doesn't name the office it cites |
| Outside names | rule break | a capitalized name that isn't in the facts the model was given (it caught "Giants"), plus a list of names models reach for: City Council, Planning Commission, Oakland, Laney, Merritt, and others |
| Outside numbers | rule break | a number the model wasn't given ("nine directors", "four-year terms"). Numbers the pack implies are allowed explicitly (Peralta: four colleges = Berkeley City College + three sister colleges). |
| Known misreadings | rule break | mistakes the model made in testing: AC Transit's "not outside the East Bay" |
| Shape | rule break / worth a look | nothing under "does not decide" (rule break); lumped decisions, a limit with no "not / only / outside" in it, the same neighbor twice, a fact number shown to the voter |
| Key facts | worth a look | dropping something the pack says (for example Peralta's three sister colleges, or AC Transit's 2028 term) |
| Judging words | worth a look | "important", "crucial", "fair", "best", "should vote", … |
| Reading grade | worth a look | Flesch–Kincaid grade 10 or above |

The free unit tests (section 6.1) prove each check catches its failure and lets a correct explanation through.

---

## 5. The illustration

**Models:** Flash-Lite picks the scene (temperature 1, answer limited to the two offered scene names). Then `google/gemini-2.5-flash-image` draws it through `POST /api/v1/images` (the same request as `examples/06-image.js`), one image at 3:2.

### 5.1 The scene menus

We wrote 6–7 scenes per office in `OFFICE_DESIGN`. Each shows a different decision from the pack, set in Berkeley or the East Bay. Each scene's `shows` field names the pack words it illustrates, and the unit tests check those words really are in the pack.

| Office | Scenes (the pack words each one shows) |
|---|---|
| Rent Board | renters reading a lease (rent ceilings) · touring an apartment (rental units) · moving in (rental units) · a tenant and landlord talking (eviction protections) · paying the rent (rent ceilings) · a landlord paying the fees (registration fees) · a street of rentals (most rental units in Berkeley) |
| AC Transit | riders at a bus stop (bus routes) · paying the fare (fares) · waiting for a late bus (service levels) · the morning commute (service levels) · a bike on the bus (bus routes) · a bus past campus (the lines running past campus) |
| BART | commuters on the platform (service hours) · through the fare gates (fares) · track work at night (capital spending) · fixing a station escalator (capital spending) · the last train (service hours) · an officer helping a rider (policing policy) · riding the train (the regional rail system) |
| EBMUD | water at the kitchen tap (water rates) · reading the water meter (water rates) · a reservoir in a dry summer (supply planning) · replacing a lawn (drought restrictions) · watering by hand (drought restrictions) · washing a car with a bucket (drought restrictions) |
| Peralta | a community college class · studying in the library · arriving for class (Berkeley City College) · planning classes with a counselor (policy) · a hands-on science lab (budget) · an evening class (three sister colleges) |

Each office also has a **place** and things to **avoid**. Avoid lists: AC Transit "only buses: no trains"; BART "only trains: no buses"; Peralta "not a university: no clock tower, no historic stone campus". Those keep the pictures from blurring the very boundaries the explanation draws.

### 5.2 How a scene is chosen (variety)

1. `scenesToOffer()` shuffles the scenes not yet shown for this office and offers **two** (`SCENE_MENU_SIZE = 2`).
2. `pickScene()` asks Flash-Lite to pick the one that best helps a voter picture what the office decides. If the page already has an explanation, its summary goes along so the picture fits the text.
3. "Draw another" passes the scenes already drawn as `exclude`, so every scene appears once before any repeats.

The handout suggests letting the AI choose. We measured that first:

| How scenes were offered | Picks per office | Different scenes seen per office |
|---|---|---|
| The whole menu, shuffled, temperature 1 | 10 | 1–3. EBMUD got "reservoir" 10 of 10 times; Peralta got "classroom" 10 of 10. |
| 3 at random | 20 | 4–5 |
| **2 at random (used)** | 20 | **5–6**: every scene, for AC Transit, EBMUD and Peralta |

Given the whole menu, the model always picks the most literal scene. The random sampling supplies the variety; the model still decides which of the two fits better.

Because our code knows which scene was picked, the caption can say what the picture shows and which pack words it illustrates. The handout's example could only say "the image API does not say which one". The image model itself never gets a choice.

### 5.3 The image prompt

`buildOfficeImagePrompt()` puts together:

```
<style>                        one style for every office, so the pictures read as one guide
Scene: <the picked scene>
Place: <the office's place>
<rules>                        the same three rules on every image
<avoid>                        the office's own exclusions, if any
```

The style (`OFFICE_IMAGE_STYLES.illustration`; a `photo` style also exists):

```
A warm editorial illustration with flat shapes and a soft paper-grain texture, soft natural light, and a muted palette of sage green, slate blue, warm ochre and cream. Calm, everyday and unposed. Full-bleed, edge to edge, with no border or frame.
```

The rules (`OFFICE_IMAGE_RULES`):

```
The people are invented, ordinary members of the community, of varied ages and backgrounds, seen from a middle distance and busy with what they are doing. No one is a real or recognizable person, and there are no close-up portraits.
Every sign, shop awning, screen, paper, poster, uniform and vehicle is plain: no words, letters, numbers, logos or symbols anywhere in the image. Papers and screens show only soft gray lines where text would be.
Nothing about elections or politics: no ballots, voting booths, campaign signs, buttons, flags, podiums, seals or government buildings.
```

A complete prompt as sent (Rent Board, "touring an apartment"):

```
A warm editorial illustration with flat shapes and a soft paper-grain texture, soft natural light, and a muted palette of sage green, slate blue, warm ochre and cream. Calm, everyday and unposed. Full-bleed, edge to edge, with no border or frame.

Scene: A young couple tours an empty, sunlit apartment in an older Berkeley building, looking out a bay window while the landlord waits by the door.
Place: Berkeley, California: a residential street of older brown-shingle houses and small two- and three-story apartment buildings, street trees, bicycles, the East Bay hills in the distance.

The people are invented, ordinary members of the community, of varied ages and backgrounds, seen from a middle distance and busy with what they are doing. No one is a real or recognizable person, and there are no close-up portraits.
Every sign, shop awning, screen, paper, poster, uniform and vehicle is plain: no words, letters, numbers, logos or symbols anywhere in the image. Papers and screens show only soft gray lines where text would be.
Nothing about elections or politics: no ballots, voting booths, campaign signs, buttons, flags, podiums, seals or government buildings.
```

### 5.4 Other visual decisions

- **Illustration, not photograph.** An illustration clearly isn't a real scene or a real person, which helps with the "no real people" rule. One consistent style also makes the five offices read as one visual system.
- **No text in pictures.** Image models write garbled words onto signs and papers, and words could make a picture look official. Scenes describe businesses by how they look, not by name: "a street of cafes" came back with a "CAFE" sign. Papers get a positive instruction ("soft gray lines where text would be"), which image models follow better than "no text".
- **White frames trimmed.** 3 of our 7 test images came back with a plain white margin despite "no border". The page trims pale borders before showing a picture (`trimFrame()` in `js/office-page.js`), so every picture fills its card the same way. Download still gives the original.

---

## 6. Testing

### 6.1 Free unit tests: `node --test tools/test-office.mjs`

21 tests, no API key needed. They check:

- every office has a design with at least 6 scenes, and every scene's `shows` words and every `powers` phrase appear in the pack
- each prompt carries the office's facts and limits, and only its chosen neighbors
- the citation `enum` lists exactly the office's fact numbers
- correct explanations pass, and each failure is caught: dropped limit, leak, outside name, outside number, bad citation, AC Transit stretch, lumping, judging words. Allowed things get through: "not BART fares", "four colleges", "the EBMUD Board".
- scene menus are random, skip scenes already shown, and start over once all are shown
- every image prompt carries the rules and never mentions voting
- `explainOffice`, `pickScene` and `illustrateOffice` behave correctly with fake API replies

### 6.2 Live tests: `tools/eval-office.mjs`

This runs the real prompts against the API and applies the same checks. With `--judge`, it adds two AI reviewers that exist only in the test harness:

- **Grounding judge** (Flash-Lite): rates every statement as supported, outside the facts, or contradicted. It separately checks whether each open question really is unanswered by the pack.
- **Picture reviewer** (Flash-Lite, reading the image): reports whether the picture matches the scene, contains text or logos, shows a real-looking person, includes election material or anything the office's avoid list rules out, or has a frame.

Both are models judging models, so they flag and a person decides. In testing, the judge missed things our word checks caught, and the word checks missed things only a person reading caught (section 7).

Results go to `tools/.cache/eval/<tag>.json` and `.md`. Pictures, plus a `contact-sheet.html` for the report, go to `tools/.cache/eval/<tag>/`.

### 6.3 Results by prompt version

| Version | What changed | Explanations | No rule break | What the test showed |
|---|---|---|---|---|
| o1 | first version; model saw all four other offices | 10 | 0/10 | 28 rule breaks: every other office listed under "does not decide", unnamed; text copied from the pack |
| o2 | neighbors only; "explain, don't copy" | 10 | 10/10 | grounded, but items still copied the pack ("Water rates for most of the East Bay.") |
| o3 | each item says what the decision means | 10 | 8/10 | both breaks were false alarms in our name check ("Directors", "Board"), so the check was fixed |
| o4 | one-sentence example; grade 9 or below; new shape checks | 10 | 10/10 | three offices lumped all their decisions into one line |
| o5 | `powers` list: one item per decision | 15 | 15/15 | lumping fixed; an AC Transit "coverage" item just restated what it does |
| o6 | "say what is left out" | 15 | 14/15 | AC Transit: "across the East Bay, not outside of it" in 3 of 3 runs; BART: "a Giants game" |
| o7 | coverage only from words like "most"; known-misreading check | 15 + 15 | 14/15, then 15/15 | the one flag was "four colleges" (implied by the pack), now allowed |

**Final run (o7):** 15 of 15 explanations with no rule break and no warning. The pack's limits were kept in 6 of 6 explanations. The judge found 0 of 90 statements outside the facts. Grades ran 4.6–7.9, and each explanation took about 2 seconds.

**Pictures:** 7 test pictures, each 1248×832, 8–10 seconds and $0.0388. The reviewer found that all 7 match their scene, with no real-looking people and no election material. It caught one "CAFE" sign (fixed). The Rent Board papers show the intended gray lines.

**Cost of all this testing:** about $0.34, of which $0.27 was the 7 pictures.

---

## 7. Failure log

| # | What the model got wrong | How it is handled now |
|---|---|---|
| 1 | Shown every office, it padded "does not decide" with all of them ("the Rent Board does not set water rates"), without naming them | It sees only the neighbors we chose. The citation check flags a cited office that isn't named. |
| 2 | Grounded but useless: it copied the pack's phrases instead of explaining them | "Explain, don't copy", one item per decision (`powers`), and a meaning that follows from the words |
| 3 | Lumped "bus routes, fares and service levels" into one line (3 of 5 offices) | The prompt lists each decision; the lumping check flags it |
| 4 | AC Transit: "decides … across the East Bay, not outside of it", in 3 of 3 runs. False (it runs transbay buses) and caused by our own instruction to "say what is left out". The AI judge called it supported. | Coverage limits may only come from words like "most"; the place example was removed; a known-misreading check catches the pattern |
| 5 | BART: "Imagine riding BART to work or to a Giants game", an invented name the judge called supported | Caught by the outside-name check, which compares every capitalized word against the facts the model was given |
| 6 | The judge rated every open question "outside the facts", and "most of the East Bay → not all areas" as outside | The judge prompt now checks questions separately ("open" vs "already answered") and explicitly allows limits that follow from the facts' own words |
| 7 | Asked to choose from the whole menu, the AI picked the same scene almost every time (EBMUD 10 of 10) | Our code offers two random scenes; already-drawn scenes are excluded |
| 8 | "A street of cafes" → a "CAFE" sign in the picture | Scenes describe shops by how they look; papers and screens get "soft gray lines" |
| 9 | White frames around 3 of 7 pictures despite "no border" | The page trims pale borders before display |
| 10 | Our number check flagged "four colleges" (1 + 3, implied by the pack) | `impliedNumbers` allows numbers the pack implies, with a comment saying why |

---

## 8. Known limits and next steps

- **The data pack says less than the handout.** The pack's office descriptions are shorter than the handout's table: no mission statements, no names for Peralta's three sister colleges, nothing about BART's nine directors. The explainer uses only the pack, so these come out as open questions.
- **The checks are imperfect.** The word checks can miss a rewording, and the judges are models judging models. Flesch–Kincaid is noisy on short list items.
- **The AI's role in picking scenes is narrow.** With two options, its choice is partly position bias. The variety comes from the sampling.
- **Results don't survive a reload.** Explanations and pictures are kept in memory only, as in the measure renderer.

---

## 9. Files

| File | What it is |
|---|---|
| `js/office.js` | Prompts, design data and checks: `OFFICE_DESIGN` (powers, neighbors, limits, scenes, places for each office), the explanation prompt and JSON schema, the no-AI checks, the scene picker, the image prompt template, and `explainOffice()` / `pickScene()` / `illustrateOffice()`. Loaded the same way by the page and both test scripts. |
| `guide.html` (Offices tab) | Functionality 3 is the guide's Down-ballot offices tab. `office.html` now only opens that tab. |
| `js/office-page.js` | The tab's code: drawing the cards, making the calls, frame trimming. Loaded by `guide.html` as a module; the session cost meter it adds to is in `js/app.js`. |
| `css/office.css` | Styles for the tab, built on `css/guide.css` (same tokens, cards and badges). |
| `tools/test-office.mjs` | The 21 free unit tests. |
| `tools/eval-office.mjs` | Live tests with the AI judges and the contact sheet. |
| `function_3.md` | This document. |
| `README.md` (edited) | Four rows added to the voter-guide file table. |

Generated by the tests and not committed (`tools/.cache/` is in `.gitignore`):

- `tools/.cache/eval/o1.*` through `o7-final.*`: every test run, readable in the `.md` files
- `tools/.cache/eval/o7-picks*.*`: the scene-variety measurements
- `tools/.cache/eval/o7-img/`: the five test pictures and `contact-sheet.html`

---

## 10. How to run

```bash
cd prog02-examples
python3 -m http.server 8000          # then open http://localhost:8000/guide.html#offices

node --test tools/test-office.mjs                                   # free
node tools/eval-office.mjs --dry --offices ac-transit-ward-1        # free: prints every prompt
node tools/eval-office.mjs --runs 3 --judge --tag try               # about $0.01: 15 explanations
node tools/eval-office.mjs --runs 0 --picks 20 --tag picks          # about $0.003: scene variety
node tools/eval-office.mjs --runs 1 --images 2 --judge --yes --tag sheet   # about $0.40: contact sheet
```
