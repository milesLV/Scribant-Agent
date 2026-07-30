# Eval datasets (prototypes — for review)

JSONL, one case per line. Every case has a `note` (what it tests) and `tags`
(for filtering/selective runs). Cases are graded against agent **output
properties**, never exact strings — LLM output varies.

## Running

`../run.ts` is the runner — no framework. It POSTs each case to a **live dev
server** (`npm run dev`), grades by properties, and prints per-case pass/fail
(with each failure's reasons inline), aggregate metrics, and a tool-selection
confusion matrix.

```bash
npm run eval                     # everything
npm run eval -- --file intent-classification    # one dataset (use a .jsonl stem: intent-classification | misheard-word-detection | correction-routing | output-quality)
npm run eval -- --tags datetime  # only cases carrying a tag
npm run eval -- --selfcheck      # grader unit tests, no network / no keys
npm run eval -- --save-baseline  # snapshot metrics as the regression gate (exits 1 on later regress)
```

Metrics emitted: `passRate`, `toolSelectionRate` (correct-category recall),
`catchRate` + `cleanFalseFlagRate` (transcriber flag path),
`correctionRecall` + `overCorrections` + `avgWER` (correction router).

## `intent-classification.jsonl` — Intent Classifier (`/api/analyze`)

```jsonc
{
  "id": "int-01",
  "tags": ["happy", "calendar", "datetime"],
  "note": "human-readable description of what this case checks",
  "now": "2026-06-27T09:00:00",        // local time context (a Saturday) for relative dates
  "transcript": "...",
  "allowExtra": false,                  // optional; when true, don't penalize items beyond those listed
  "expect": {
    "calendar": [ { "match": "grandmother", "uncertain": false,
                    "allDay": false, "startDate": "2026-06-28", "startHour": 15 } ],
    "tasks":    [ { "match": "schema", "dueDate": "2026-06-30" } ],
    "search":   [ { "match": "Concorde" } ]
  }
}
```

Item expectation fields (all optional except `match`):
- `match` — keyword that must appear in the produced item's `sourceText`/title/query.
- `uncertain` — assert the `uncertain` flag (calendar + task).
- `allDay` — assert the calendar event's `allDay` flag (occurrence vs timed).
- `startDate` (`YYYY-MM-DD`) / `startHour` (0–23, local) — calendar datetime resolution.
- `dueDate` (`YYYY-MM-DD`, local) — assert the task's resolved deadline.

Grading rules:
- **Recall** — for each expected item there must be a produced item *in that
  category* whose `sourceText` (preferred) or `title`/`query` contains `match`
  (case-insensitive substring).
- **Abstention / over-generation** — all three category keys are **always
  present**; an empty `[]` means *that category must be empty*. A produced item
  where `[]` was expected is a precision failure, **unless the case sets
  `allowExtra: true`** (used when an extra item is defensible, e.g. a deadline
  that is itself an event). This is how the strict "don't make an item from a
  vague statement" rules get tested.
- **`uncertain`** — checked only when specified on the expected item.
- **Datetime** — when `startDate` (`YYYY-MM-DD`, local) and/or `startHour`
  (0–23, local) are given, parse the produced `start` and compare. Only put
  these on **unambiguous** relative terms ("tomorrow", "in three days",
  "tonight") so the check isn't flaky.
- **`sourceText` fidelity** is a separate deterministic guard run over *all*
  outputs: every produced item's `sourceText` must resolve via `locateSpan`
  into the transcript (non-null). No dataset field needed.

## `misheard-word-detection.jsonl` — wrong-word detection (`/api/transcribe-correct`)

```jsonc
{
  "id": "tr-01",
  "tags": ["happy", "homophone"],
  "note": "...",
  "text": "Call grandma tomorow about the tickets.",
  "expectCaught": [ { "match": "tomorow", "suggestionIncludes": "tomorrow" } ],
  "expectClean":   ["grandma", "tickets"]
}
```

Runs against the router (`/api/transcribe-correct`), so a wrong word counts as
"detected" whether the router **flagged** it (low-confidence `Word`) or
**auto-corrected** it (entry in `corrections`). This dataset tests detection
recall + precision at a coarser grain than `correction-routing.jsonl`, which
tests the flag-vs-correct *decision* itself.

Grading rules:
- **Recall** — each `expectCaught` word must be detected: either a produced
  `Word` with `confidence < 0.7` or a `corrections` entry whose `from` matches
  `match` (punctuation-insensitive). If `suggestionIncludes` is given, it must
  appear in that word's `alternatives` or the correction's `to`.
- **Precision** — no `expectClean` word may be flagged *or* corrected. These are
  the false-positive traps (rare-but-correct terms, correct homophones, proper nouns).

## `correction-routing.jsonl` — correct-vs-flag router (`/api/transcribe-correct`)

Tests the routing decision: obvious typo/grammar → **auto-correct**; ambiguous
mishearing → **flag** (low-confidence); already self-corrected → **do nothing**.

```jsonc
{
  "id": "cor-h1",
  "tags": ["happy", "typo"],
  "text": "I need to bye milk tomorow.",
  "gold": "I need to buy milk tomorrow.",         // optional — enables WER
  "expect": {
    "correct": [ { "from": "bye", "to": "buy" }, { "from": "tomorow", "to": "tomorrow" } ],
    "flag":    [ { "match": "peer", "suggestionIncludes": "pier" } ]
  }
}
```

Grading: **correction recall** (each `correct` must appear in produced
`corrections` with the right `to`), **over-correction** (any produced
correction not expected → fail; this is the false-correction / clean-input
trap), **flag recall/precision** (same as transcriber but on the router's
low-confidence `words`), and **WER** = word-edit-distance(corrected, `gold`) /
`gold` length when `gold` is present.

## `output-quality.jsonl` — final-tool-output quality

Layer-2 content quality, separate from *which* tool fired. Search must return a
condensed (1–2 sent) + in-depth (4–7 sent) summary + real sources; calendar/task
items must have correct title/detail/time.

Grading is **deterministic** for the structural/factual `judge` fields —
`condensedSentences`/`inDepthSentences` (sentence-count ranges), `mustMention`,
`sourcesMin`, `titleMentions`, `detailMentions`, `startDate`/`startHour`. The
optional `judge.quality` field is a natural-language rubric graded by an **LLM
judge**, run only under `npm run eval -- --judge` (costs tokens; needs a
`GEMINI_API_KEY`). Search cases hit `/api/search`; calendar/task cases hit
`/api/analyze` and inspect the first produced item (routed by the `calendar` /
`task` tag).

## Task vs calendar model (used by these cases)
Primary axis is **occurrence vs action**, not "task vs calendar":
- *Occurrence* (happens / occupies time, you attend) -> **calendar event**;
  `allDay:true` when it spans whole days with no clock time (trip, birthday).
- *Action* (you do and check off, anytime) -> **task**; `dueDate` when bounded.
- Not concrete/actionable -> dropped.
A "feels like both" item is a **task with a `dueDate`** (its deadline may be a
separate event); no item lives in two categories. See `int-22`/`int-23`/`int-25`.

## Open questions surfaced while writing these
- `int-10` (gym next week) now resolves cleanly under the occurrence/action
  rule: a flexible action -> **task (uncertain)**. This also fixes the old
  prompt's self-contradiction.
- `int-19` (find cheapest insurance *and* switch) is a genuinely ambiguous
  search-vs-task split; it currently expects both. Adjust to taste.
- `tr-10`/`tr-12` (proper noun, fictional-but-coherent term) enforce "don't
  flag unfamiliar-but-plausible words." These are the hardest precision cases
  and may legitimately fail until the proofreader prompt is tuned.
