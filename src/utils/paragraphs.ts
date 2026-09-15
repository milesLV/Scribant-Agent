// The single place a paragraph break is decided. Pure + browser-safe (no node imports).
//
// Live speech has no paragraphs — we invent them, and the model we invent them under is FICTION's,
// not the essay's. Fiction breaks on discrete events (a new speaker, a new actor, a shift in scene)
// and lets length fall out as a consequence; the essay breaks on "one idea per paragraph" and the
// web breaks on visual pacing. Only the fiction model has triggers a machine can actually observe
// in a dictated stream, which is why it's the one encoded here.
//
// What this file deliberately does NOT do:
//   - It does not read punctuation as a primary signal. Chrome's Web Speech auto-punctuation is
//     inconsistent (it punctuates confident, well-formed phrases and skips short or uncertain ones),
//     so a rule keyed on a trailing period fires erratically on identical speech. Punctuation only
//     ever REFINES a break that another rule already earned.
//   - It does not consider pause duration. Prosody is the strongest cue in the segmentation
//     literature, but it is out of scope by request; the shape below leaves room for it without
//     assuming it.

export type BreakKind = "none" | "paragraph" | "scene";

export type UtteranceSource = "speech" | "stt" | "tab" | "typed";

/** One contiguous run of text from a single producer, with whatever structure that producer knows. */
export interface Utterance {
  text: string;
  /** Diarized speaker label. `undefined` means solo narration — NOT "unknown speaker". */
  speaker?: string;
  source: UtteranceSource;
  /**
   * Producer-asserted hard boundary: a new recording session, a `[Meeting]` chunk header, a
   * resumed capture. Fiction's scene break rather than its paragraph break — the tier above.
   */
  startsScene?: boolean;
}

/**
 * The paragraph currently being written into. Carried explicitly rather than re-derived from the
 * rendered string: recovering speaker identity by regex-matching "Speaker 1:" back out of the text
 * is how the current code loses track of it, and a paragraph's word count can't be recovered from
 * the tail at all once a producer has trimmed it.
 */
export interface OpenParagraph {
  speaker?: string;
  /** Words accumulated in THIS paragraph, across every utterance folded into it so far. */
  words: number;
  endsSentence: boolean;
  /** The narrative mode this paragraph is currently running in. */
  mode: NarrativeMode;
  /** How long that run is, in sentence-ish units — see `sentenceUnits`. */
  sentences: number;
}

export const EMPTY_PARAGRAPH: OpenParagraph =
  Object.freeze({ words: 0, endsSentence: false, mode: "narration" as NarrativeMode, sentences: 0 });

/**
 * Length caps, in words. These are the LAST rule consulted, not the first — a safety net for the
 * case where no structural trigger has fired in a long time (solo dictation, one speaker, no scene
 * markers), so the reader never faces an unbroken wall.
 *
 * The band comes from machine-paragraphing practice for transcripts, which breaks on length
 * thresholds around 50-100 words. The soft cap waits for a sentence to end so the break lands on a
 * real boundary; the hard cap gives up waiting, because if punctuation never arrives (see above) a
 * sentence-gated cap would never fire at all.
 *
 * They are measured differently on purpose. The soft cap reads the words ALREADY in the paragraph,
 * so a paragraph is never cut short of it. The hard cap reads what the paragraph WOULD hold once
 * this utterance joins, so it is a true ceiling — measuring it the other way lets a paragraph
 * overshoot by a whole utterance (three 50-word chunks reach 150 under a 110 cap before the fourth
 * finally trips it).
 */
export const SOFT_CAP_WORDS = 60;
export const HARD_CAP_WORDS = 110;

export interface ParagraphOptions {
  softCapWords?: number;
  hardCapWords?: number;
  /** Set false to disable rule 3 (narrative-mode breaks). Modes are still tracked either way. */
  detectMode?: boolean;
}

/**
 * Whitespace only, deliberately. The joined transcript is fed verbatim to the proofreader and
 * summarizer agents, so a visible scene marker ("* * *") would become tokens they have to explain
 * away. Two tiers stay distinguishable to a renderer that splits on `\n{3,}` before `\n{2}`.
 */
export const SEPARATORS: Record<BreakKind, string> = {
  none: " ",
  paragraph: "\n\n",
  scene: "\n\n\n",
};

/* --- narrative mode -------------------------------------------------------------------------- */

/**
 * The kinds of thing a person does while thinking out loud. Fiction's five narrative types (action,
 * reaction, dialogue, interiority, observation) don't transfer — a brain dump has no cast — but the
 * underlying move does: a paragraph holds one KIND of material, and changing kind starts a new one.
 */
export type NarrativeMode = "narration" | "intent" | "question" | "aside";

/** Sentence-ish units a mode must run for before a change is allowed to break the paragraph. */
export const MODE_MIN_SENTENCES = 2;

// Openers that mark a deliberate turn away from what was being said. Stripped before classifying,
// and on their own they mean "aside" — the spoken equivalent of a parenthetical.
const SHIFT_MARKERS = [
  "actually", "wait", "hang on", "hold on", "anyway", "anyways", "by the way", "side note",
  "scratch that", "never mind", "nevermind", "on second thought", "i mean", "oh wait",
];

// Openers with no rhetorical weight at all. Also stripped, but they signal nothing — treating
// "so" or "and" as a mode shift would break a paragraph every other utterance, which is exactly
// the over-breaking the length caps already guard against.
const FILLERS = ["um", "uh", "erm", "er", "okay", "ok", "so", "and", "but", "like", "well", "yeah", "right", "now"];

// Committing to a future action: the single most useful thing to isolate in a thought stream,
// because it is what the planner stage downstream is looking for.
const INTENT_CUES = [
  "i need to", "i have to", "i've got to", "i gotta", "i should", "i must", "i want to", "i'll",
  "i am going to", "i'm going to", "we need to", "we have to", "we should", "we'll", "we're going to",
  "let's", "lets", "remind me", "remember to", "make sure", "don't forget", "note to self",
  "todo", "to do", "next step", "action item", "follow up", "follow-up",
];

// Deliberately narrower than "starts with a wh-word": "what I really meant was..." is narration,
// not a question, so bare wh-openers are not enough on their own.
const QUESTION_CUES = [
  "what if", "what about", "why is", "why are", "why do", "why did", "how do", "how does",
  "how can", "how should", "how would", "should we", "should i", "can we", "can i", "could we",
  "do we", "does that", "is that", "is it", "are we", "any idea", "anyone know",
];

// The "Speaker 1: " that toUtterances keeps inside the text for the renderer would otherwise sit in
// front of every cue and defeat all of them.
const stripSpeakerPrefix = (text: string) =>
  text.replace(/^\s*(?:\[Meeting[^\]]*\]|Speaker\s*\d+|You)\s*:?\s*/i, "");

const startsWithCue = (text: string, cues: string[]) =>
  cues.some(c => text === c || text.startsWith(c + " ") || text.startsWith(c + ","));

/**
 * Which mode an utterance MARKS, from its opening words alone — or null when it marks nothing.
 *
 * Null means "continues whatever is running", not "narration". Cue matching can only ever detect a
 * marked transition; the absence of a cue is silence on the question, and reading it as a positive
 * vote for narration makes a continued run flip modes halfway through. "I need to write the
 * rollback plan" / "and book time with the platform team" is one intent run — the second utterance
 * carries no cue, and treating that as a return to narration both loses the run and swallows the
 * next real transition.
 *
 * Leading markers are peeled off FIRST and the remainder is what gets classified, so "actually I
 * need to call him" reads as intent (its real content) rather than as an aside that happens to
 * start with a marker. A marker in front of otherwise unmarked text is what actually makes an aside.
 */
export function classifyMode(text: string): NarrativeMode | null {
  let rest = stripSpeakerPrefix(text).trim().toLowerCase().replace(/^[^a-z0-9'"]+/, "");
  const endsQuestion = /\?["'”’)\]]*$/.test(rest);

  let shifted = false;
  // Peel repeatedly: "okay so actually..." is one opener, not three utterances.
  for (let peeled = true; peeled;) {
    peeled = false;
    for (const m of SHIFT_MARKERS) {
      if (startsWithCue(rest, m ? [m] : [])) {
        rest = rest.slice(m.length).replace(/^[^a-z0-9'"]+/, "");
        shifted = peeled = true;
        break;
      }
    }
    if (peeled) continue;
    for (const f of FILLERS) {
      if (startsWithCue(rest, [f])) {
        rest = rest.slice(f.length).replace(/^[^a-z0-9'"]+/, "");
        peeled = true;
        break;
      }
    }
  }

  if (startsWithCue(rest, INTENT_CUES)) return "intent";
  if (endsQuestion || startsWithCue(rest, QUESTION_CUES)) return "question";
  if (shifted) return "aside";
  return null;
}

/**
 * How many sentences an utterance is worth. Terminators when the recognizer supplied them, and at
 * least one regardless — a mode gate that counted only real punctuation would never open on the
 * Web Speech path, which is the whole reason punctuation is not trusted anywhere else here either.
 */
export const sentenceUnits = (text: string) =>
  Math.max(1, (text.match(/[.!?]+(?=["'”’)\]]*(?:\s|$))/g) ?? []).length);

/* --------------------------------------------------------------------------------------------- */

// Solo narration (`undefined`) and a blank label are the same speaker, not two different ones —
// otherwise a producer that omits the field on some chunks breaks on every single utterance.
const speakerKey = (s?: string) => (s ?? "").trim().toLowerCase();

const countWords = (text: string) => {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
};

// Trailing quotes and brackets are allowed to sit after the terminator: `he left."` still ends a
// sentence. Used only to decide WHERE a length-driven break lands, never whether one happens.
const endsSentence = (text: string) => /[.!?]["'”’)\]]*\s*$/.test(text.trim());

/**
 * The whole rule set, in priority order — first match wins. Every producer's break decision routes
 * through this function and no other, so the rules can only ever disagree in one place.
 */
export function breakBefore(
  open: OpenParagraph,
  next: Utterance,
  opts: ParagraphOptions = {},
): BreakKind {
  // Nothing to break away from. Also covers a `startsScene` first utterance: a scene break before
  // the opening line would render as leading blank space.
  if (open.words === 0) return "none";
  if (!next.text.trim()) return "none";

  // 1. Producer-asserted scene boundary. Outranks everything below it.
  if (next.startsScene) return "scene";

  // 2. New speaker = new paragraph. Fiction's hardest rule and the only one with near-universal
  //    agreement across every style tradition; readers decode speaker alternation from the break
  //    alone, so a missed one is far more costly than a spurious one.
  if (speakerKey(open.speaker) !== speakerKey(next.speaker)) return "paragraph";

  // 3. New narrative type = new paragraph. Fiction breaks when the mode changes (action ->
  //    reaction -> dialogue -> interiority); the dictated-thought analogue is narration -> intent
  //    -> question -> aside. Gated on the OUTGOING run being at least MODE_MIN_SENTENCES long, so
  //    a single stray cue word cannot break a paragraph that has barely started — this is the
  //    highest-false-positive rule in the set and the gate is what makes it safe to leave on.
  if (opts.detectMode !== false && open.sentences >= MODE_MIN_SENTENCES) {
    const marked = classifyMode(next.text);
    if (marked && marked !== open.mode) return "paragraph";
  }

  const soft = opts.softCapWords ?? SOFT_CAP_WORDS;
  const hard = opts.hardCapWords ?? HARD_CAP_WORDS;

  // 4. Length safety net. Sentence-gated first so the break lands cleanly, then forced.
  if (open.words >= soft && open.endsSentence) return "paragraph";
  if (open.words + countWords(next.text) > hard) return "paragraph";

  return "none";
}

/**
 * Fold one utterance into the open paragraph: the break decision plus the resulting state, so a
 * caller never has to reset `words`/`speaker` by hand and get it subtly wrong.
 *
 * Append-only by construction — it reads the OPEN paragraph and nothing behind it. Text already
 * committed upstream is never revisited, which is what keeps the proofreader's character offsets
 * valid across a live append (they are guarded by a `startsWith` prefix check on the transcript).
 */
export function absorb(
  open: OpenParagraph,
  next: Utterance,
  opts: ParagraphOptions = {},
): { kind: BreakKind; open: OpenParagraph } {
  if (!next.text.trim()) return { kind: "none", open };

  const kind = breakBefore(open, next, opts);
  const marked = classifyMode(next.text);
  // A mode change that did NOT break (the gate was still closed) still restarts the run: the
  // paragraph is in the new mode from here, and the new mode has to earn its own two units before
  // it can be broken away from. Without this, rapid mode flapping would break on every utterance.
  const continues = kind === "none";
  // Unmarked text inherits: within a paragraph it continues the run, and a fresh paragraph opened
  // by an unmarked utterance starts neutral.
  const mode = marked ?? (continues ? open.mode : "narration");
  const sameMode = continues && mode === open.mode;

  return {
    kind,
    open: {
      speaker: next.speaker,
      words: (continues ? open.words : 0) + countWords(next.text),
      endsSentence: endsSentence(next.text),
      mode,
      sentences: (sameMode ? open.sentences : 0) + sentenceUnits(next.text),
    },
  };
}

/**
 * Fold a batch of utterances into the open paragraph, returning the text to APPEND and the state to
 * carry forward. Split from the string splice below so a caller can advance its paragraph state
 * OUTSIDE a React state updater — updaters may run more than once, and an updater that advanced the
 * state itself would apply every break twice.
 *
 * `addition` always leads with a separator (or is empty). Nothing here reads the existing
 * transcript, which is what makes appending strictly additive.
 */
export function foldUtterances(
  open: OpenParagraph,
  utterances: Utterance[],
  opts: ParagraphOptions = {},
): { addition: string; open: OpenParagraph } {
  let addition = "";
  let current = open;

  for (const u of utterances) {
    let text = u.text.trim();
    if (!text) continue;
    const { kind, open: next } = absorb(current, u, opts);
    // `toUtterances` bakes the "Speaker N: " prefix into the text, because that is what the editor
    // and the downstream agents read. When this utterance CONTINUES the open paragraph it is by
    // definition the same speaker (break rule 2), so re-stating the label mid-paragraph would
    // render "Speaker 2: hey Speaker 2: still me" — one label per 8s chunk, forever. A label that
    // opens a NEW paragraph is kept: a length-capped monologue should name its speaker again.
    // `current.words > 0` matters: the FIRST utterance also reports "none" (there is nothing to
    // break away from), and stripping there would leave the opening paragraph unattributed.
    if (kind === "none" && current.words > 0 && u.speaker) {
      const prefix = `${u.speaker}: `;
      if (text.startsWith(prefix)) text = text.slice(prefix.length);
    }
    addition += SEPARATORS[kind] + text;
    current = next;
  }

  return { addition, open: current };
}

/**
 * Attach a fold's `addition` to the transcript. trimEnd rather than trim: the leading whitespace is
 * the user's (see preserveHead in ./transcript), and only an empty transcript drops the separator
 * the addition leads with.
 */
export function spliceAddition(prev: string, addition: string): string {
  if (!addition) return prev;
  return prev.trim() ? prev.trimEnd() + addition : addition.trimStart();
}

/**
 * Render a whole utterance list to the flat string the editor and the agents consume. One
 * implementation shared with the live path — batch rendering and incremental appending cannot drift
 * apart because there is nothing to drift from.
 */
export function joinUtterances(utterances: Utterance[], opts: ParagraphOptions = {}): string {
  return spliceAddition("", foldUtterances(EMPTY_PARAGRAPH, utterances, opts).addition);
}

/* --- producer adapters ------------------------------------------------------------------ */

// The parts of a /api/transcribe-audio response this file needs. Structural rather than imported
// from openapi.ts so the browser bundle stays free of server code; the fields mirror
// TranscribeAudioResponseSchema and are checked against it by the caller's types.
export interface TranscribeTurn {
  speaker: string;
  text: string;
}
export interface TranscribeResponse {
  text: string;
  speakerCount?: number;
  turns?: TranscribeTurn[];
  /** Server-side latch: true once THIS SESSION has ever held 2+ speakers. See speaker-registry.ts. */
  multiSpeaker?: boolean;
  /**
   * The user configured more than one expected speaker, so label from the very first word rather
   * than waiting for a second voice to actually show up. Set by the caller from the STT config, not
   * by the server — it is a statement of intent, not of observation.
   */
  alwaysLabel?: boolean;
}

/**
 * Lift a transcription response into utterances — the ONE place a wire response becomes something
 * `absorb` can reason about.
 *
 * Cloud STT already computes diarized turns and the server already returns them; the client used to
 * read only the flattened `text` and then recover speakers by testing whether the string contained
 * `"Speaker "` anywhere. That sniff is what made breaks sticky: once any chunk mentioned a speaker,
 * every later chunk matched too, so every append broke forever after.
 *
 * A speaker label is attached ONLY when the SESSION holds more than one speaker — a solo recording
 * returns `undefined`, which reads as narration and lets consecutive chunks flow together. Labelling
 * a lone speaker would break the transcript between every chunk.
 *
 * "Session", not "chunk", is load-bearing and was the original bug. Deciding per chunk means a
 * window in which only one of two people happened to speak comes back unlabelled, and `speakerKey`
 * maps every absent label to "" — so two CONSECUTIVE unlabelled windows share a key and merge into
 * one paragraph, running two different people together. (An unlabelled window after a labelled one
 * does break.) The server latches the fact once two voices are confirmed across chunks and sends it
 * as `multiSpeaker`.
 *
 * Speaker labels themselves are CHUNK-LOCAL — "Speaker 1" in consecutive chunks is not guaranteed
 * to be the same person. Acoustic re-identification across requests was tried and measurably made
 * things worse; see speaker-registry.ts.
 */
export function toUtterances(res: TranscribeResponse, source: UtteranceSource): Utterance[] {
  const scene = (text: string) => (text.trimStart().startsWith("[Meeting") ? true : undefined);

  const turns = res.turns ?? [];
  if (turns.length) {
    const distinct = new Set(turns.map(t => (t.speaker ?? "").trim()).filter(Boolean));
    // Label when THIS chunk shows two voices, or when the session has been latched multi-speaker.
    // Both halves are load-bearing.
    //
    // Without the first, the chunk that actually catches two people goes unlabelled — the latch
    // needs corroboration across chunks, so it is still false on that very chunk.
    //
    // Without the second, consecutive chunks in which only ONE of two people speaks all come back
    // unlabelled. `speakerKey` maps every absent label to "", so those chunks share a key and MERGE
    // into one paragraph — two different people run together with no break. (An unlabelled chunk
    // following a LABELLED one does break; "" and "speaker 2" differ. It is unlabelled-next-to-
    // unlabelled that collapses, which is exactly what a solo chunk in a two-person session is.)
    //
    // `alwaysLabel` short-circuits both: the detection-based halves can only ever act AFTER a
    // second voice has been heard, so the opening stretch of a two-person recording — everything
    // said before the other person first speaks — is committed unlabelled and stays that way.
    // Nothing can retro-label it without rewriting committed text, which the proofreader's
    // character offsets forbid. Asking the user instead ("max speakers > 1") is the only signal
    // available at word one.
    const multi = (res.alwaysLabel ?? false) || (res.multiSpeaker ?? false) || distinct.size > 1;

    return turns
      .filter(t => t.text?.trim())
      .map(t => ({
        // The "Speaker N: " prefix stays inside the text: it is what the transcript renderer and
        // the downstream agents read. `speaker` carries the same fact in a form break rules can
        // use without parsing it back out again.
        text: multi ? `${t.speaker}: ${t.text.trim()}` : t.text.trim(),
        speaker: multi ? t.speaker : undefined,
        source,
        startsScene: scene(t.text),
      }));
  }

  // No diarization (or the Gemini fallback, which returns none): one undivided utterance. No
  // synthetic turn is invented here — asserting a speaker nobody detected would make solo speech
  // break between every chunk.
  const text = res.text?.trim();
  return text ? [{ text, source, startsScene: scene(text) }] : [];
}

// ponytail: self-check pins the rule PRIORITY and the two properties the old inline rules broke —
// a speaker change breaks without punctuation, and an unpunctuated run still breaks eventually.
// Run: tsx src/utils/paragraphs.ts
if (typeof process !== "undefined" && process.argv[1]?.endsWith("paragraphs.ts")) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const ok = (cond: boolean, m: string) => { if (!cond) throw new Error(m); };
  const say = (text: string, extra: Partial<Utterance> = {}): Utterance =>
    ({ text, source: "stt", ...extra });
  // n words of filler, unpunctuated unless asked — the caps are the only rule that reads length.
  const filler = (n: number, end = "") =>
    Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ") + end;
  // `speaker` first so the literal's key ORDER matches what absorb() returns — eq() compares
  // JSON, which is order-sensitive.
  const open = (o: Partial<OpenParagraph>): OpenParagraph =>
    ({ speaker: undefined, words: 0, endsSentence: false, mode: "narration", sentences: 0, ...o });

  // --- first utterance: nothing to break away from ---
  eq(breakBefore(EMPTY_PARAGRAPH, say("hello")), "none", "first utterance never breaks");
  eq(breakBefore(EMPTY_PARAGRAPH, say("hello", { startsScene: true })), "none",
    "scene flag on the FIRST utterance does not emit a leading break");

  // --- speaker change: the hardest rule, and it must not need punctuation ---
  eq(breakBefore(open({ speaker: "Speaker 1", words: 3 }), say("hi", { speaker: "Speaker 2" })),
    "paragraph", "new speaker breaks");
  eq(breakBefore(open({ speaker: "Speaker 1", words: 3 }), say("hi", { speaker: "Speaker 1" })),
    "none", "same speaker does not break");
  eq(breakBefore(open({ speaker: "speaker 1 ", words: 3 }), say("hi", { speaker: "Speaker 1" })),
    "none", "speaker match ignores case and surrounding space");
  eq(breakBefore(open({ words: 3 }), say("hi")), "none",
    "solo narration: undefined speaker is not a change");
  eq(breakBefore(open({ words: 3 }), say("hi", { speaker: "" })), "none",
    "blank label reads as solo, not as a second speaker");
  eq(breakBefore(open({ words: 3 }), say("hi", { speaker: "Speaker 2" })), "paragraph",
    "solo -> labelled speaker breaks");

  // --- scene tier outranks the speaker rule ---
  eq(breakBefore(open({ speaker: "Speaker 1", words: 3 }), say("x", { speaker: "Speaker 1", startsScene: true })),
    "scene", "scene flag outranks an unchanged speaker");
  eq(breakBefore(open({ speaker: "Speaker 1", words: 3 }), say("x", { speaker: "Speaker 2", startsScene: true })),
    "scene", "scene flag outranks a speaker change too");

  // --- length safety net ---
  eq(breakBefore(open({ words: 59, endsSentence: true }), say("x")), "none",
    "under the soft cap: a finished sentence is not on its own a reason to break");
  eq(breakBefore(open({ words: 60, endsSentence: true }), say("x")), "paragraph",
    "at the soft cap, a finished sentence lands the break");
  eq(breakBefore(open({ words: 60, endsSentence: false }), say("x")), "none",
    "at the soft cap, an unfinished sentence waits");
  eq(breakBefore(open({ words: 110, endsSentence: false }), say("x")), "paragraph",
    "hard cap fires with no punctuation at all — the old rule could stall here forever");
  eq(breakBefore(open({ words: 100, endsSentence: false }), say(filler(9))), "none",
    "hard cap counts the incoming words: 109 still fits");
  eq(breakBefore(open({ words: 100, endsSentence: false }), say(filler(11))), "paragraph",
    "...and trips one word over, so the cap is a real ceiling rather than a floor");
  eq(breakBefore(open({ words: 200, endsSentence: false }), say("x"), { softCapWords: 5, hardCapWords: 10 }),
    "paragraph", "caps are overridable");

  // --- blank input is inert ---
  eq(breakBefore(open({ words: 3 }), say("   ", { speaker: "Speaker 9" })), "none",
    "blank text never breaks, even on a speaker change");
  eq(absorb(open({ speaker: "Speaker 1", words: 3 }), say("  ")),
    { kind: "none", open: open({ speaker: "Speaker 1", words: 3 }) },
    "blank text leaves the open paragraph untouched");

  // --- absorb: word accumulation and reset ---
  eq(absorb(open({ speaker: "Speaker 1", words: 4 }), say("two more words here", { speaker: "Speaker 1" })),
    { kind: "none", open: open({ speaker: "Speaker 1", words: 8, sentences: 1 }) },
    "no break: words accumulate across the paragraph");
  eq(absorb(open({ speaker: "Speaker 1", words: 40, sentences: 3 }), say("done.", { speaker: "Speaker 2" })),
    { kind: "paragraph", open: open({ speaker: "Speaker 2", words: 1, endsSentence: true, sentences: 1 }) },
    "break: word and sentence counts reset to the new paragraph's first utterance");
  eq(absorb(EMPTY_PARAGRAPH, say('he left."')).open.endsSentence, true,
    "a terminator behind a closing quote still ends the sentence");

  // --- joinUtterances: one rule set, no leading separator, both tiers rendered ---
  eq(joinUtterances([
    say("Morning all", { speaker: "Speaker 1" }),
    say("Hey", { speaker: "Speaker 2" }),
    say("ready when you are", { speaker: "Speaker 2" }),
  ]), "Morning all\n\nHey ready when you are",
    "speakers break; a speaker's own continuation does not");
  eq(joinUtterances([say("one"), say("  "), say("two")]), "one two",
    "blank utterances vanish without leaving a separator behind");
  eq(joinUtterances([say("before"), say("after", { startsScene: true })]), "before\n\n\nafter",
    "scene break renders as the wider gap");
  eq(joinUtterances([]), "", "empty list renders empty");

  // The regression this whole file exists for: a long unpunctuated solo run used to come out as one
  // wall of text, because the only rules were "previous text ended in .!?" and a 16-word count.
  const wall = joinUtterances(Array.from({ length: 8 }, () => say(filler(50))));
  const paras = wall.split("\n\n");
  eq(paras.length, 4, "unpunctuated solo speech still gets broken up by the hard cap");
  eq(wall.includes("\n\n\n"), false, "...and only at the paragraph tier, never as a scene break");
  eq(paras.every(p => countWords(p) <= HARD_CAP_WORDS), true,
    "no paragraph ever exceeds the hard cap");

  // --- toUtterances: structure survives the wire instead of being re-sniffed from the string ---
  const twoSpeakers = {
    text: "Speaker 1: morning\n\nSpeaker 2: hey",
    speakerCount: 2,
    turns: [{ speaker: "Speaker 1", text: "morning" }, { speaker: "Speaker 2", text: "hey" }],
  };
  eq(toUtterances(twoSpeakers, "stt"), [
    { text: "Speaker 1: morning", speaker: "Speaker 1", source: "stt", startsScene: undefined },
    { text: "Speaker 2: hey", speaker: "Speaker 2", source: "stt", startsScene: undefined },
  ], "multi-speaker chunk becomes one utterance per turn, label kept in the text AND in the field");
  eq(joinUtterances(toUtterances(twoSpeakers, "stt")), "Speaker 1: morning\n\nSpeaker 2: hey",
    "...and rendering them reproduces the server's own turn formatting");

  const solo = { text: "just me talking", speakerCount: 1, turns: [{ speaker: "Speaker 1", text: "just me talking" }] };
  eq(toUtterances(solo, "stt"), [{ text: "just me talking", speaker: undefined, source: "stt", startsScene: undefined }],
    "a lone speaker is left unlabelled — labelling it would break between every chunk");
  eq(joinUtterances([...toUtterances(solo, "stt"), ...toUtterances(solo, "stt")]),
    "just me talking just me talking",
    "consecutive solo chunks flow together instead of breaking");

  eq(toUtterances({ text: "no turns here" }, "tab"),
    [{ text: "no turns here", source: "tab", startsScene: undefined }],
    "Gemini fallback (no turns) yields one undivided utterance, no invented speaker");
  eq(toUtterances({ text: "" }, "tab"), [], "an empty response yields nothing to append");
  eq(toUtterances({ text: "[Meeting] agenda review", speakerCount: 1 }, "tab")[0].startsScene, true,
    "a meeting header opens a scene");
  eq(toUtterances({ text: "x", speakerCount: 2, turns: [{ speaker: "Speaker 1", text: "  " }] }, "stt"),
    [], "blank turns are dropped rather than emitted as empty paragraphs");

  // --- the latch: a session that has met two people keeps labelling, even on a solo window ------
  // This is the regression that folded one speaker's whole window into the other's paragraph.
  const latchedSolo = {
    text: "still just me",
    speakerCount: 2,
    multiSpeaker: true,
    turns: [{ speaker: "Speaker 2", text: "still just me" }],
  };
  eq(toUtterances(latchedSolo, "stt"),
    [{ text: "Speaker 2: still just me", speaker: "Speaker 2", source: "stt", startsScene: undefined }],
    "a latched session labels a window holding only one voice");
  eq(joinUtterances([...toUtterances(twoSpeakers, "stt"), ...toUtterances(latchedSolo, "stt")]),
    "Speaker 1: morning\n\nSpeaker 2: hey still just me",
    "...and that label keeps Speaker 2's window out of Speaker 1's paragraph");
  // The label is stated ONCE per paragraph. Every chunk arrives prefixed, so without the strip in
  // foldUtterances a single speaker renders "Speaker 2: hey Speaker 2: still just me" and gains a
  // label every 8 seconds for as long as they keep talking.
  ok(!joinUtterances([...toUtterances(twoSpeakers, "stt"), ...toUtterances(latchedSolo, "stt")])
    .includes("hey Speaker 2:"), "a continued speaker does not re-state their label mid-paragraph");
  // ...but a paragraph the length cap forces open DOES re-state it, so the new block is attributed.
  eq(joinUtterances([
      { text: `Speaker 1: ${filler(HARD_CAP_WORDS)}`, speaker: "Speaker 1", source: "stt" },
      { text: "Speaker 1: and then some more", speaker: "Speaker 1", source: "stt" }])
      .split("\n\n").length, 2, "a length-capped break opens a new paragraph");
  ok(joinUtterances([
      { text: `Speaker 1: ${filler(HARD_CAP_WORDS)}`, speaker: "Speaker 1", source: "stt" },
      { text: "Speaker 1: and then some more", speaker: "Speaker 1", source: "stt" }])
      .endsWith("Speaker 1: and then some more"), "...and it keeps the label at the top of it");

  // alwaysLabel: the user said to expect more than one speaker, so a solo opening is still labelled.
  eq(toUtterances({ ...solo, multiSpeaker: false, alwaysLabel: true, turns: [{ speaker: "Speaker 1", text: "just me talking" }] }, "stt"),
    [{ text: "Speaker 1: just me talking", speaker: "Speaker 1", source: "stt", startsScene: undefined }],
    "alwaysLabel labels a solo turn from word one");
  // ...and consecutive same-speaker turns still share a speakerKey, so they do NOT break apart.
  eq(joinUtterances([
      ...toUtterances({ text: "x", alwaysLabel: true, turns: [{ speaker: "Speaker 1", text: "opening thought" }] }, "stt"),
      ...toUtterances({ text: "x", alwaysLabel: true, turns: [{ speaker: "Speaker 1", text: "and the rest of it" }] }, "stt")])
      .split("\n\n").length, 1, "alwaysLabel does not break a solo speaker between chunks");

  eq(toUtterances({ ...solo, multiSpeaker: false }, "stt"),
    [{ text: "just me talking", speaker: undefined, source: "stt", startsScene: undefined }],
    "an explicit false latch still leaves solo dictation unlabelled");
  eq(toUtterances({ text: "x", speakerCount: 2, multiSpeaker: false, turns: [{ speaker: "Speaker 1", text: "hi" }] }, "stt")[0].speaker,
    undefined, "the server's latch outranks a stale per-chunk speakerCount");

  // The fold-in the latch exists to prevent: two consecutive chunks, each holding one voice but a
  // DIFFERENT one, both unlabelled. Their speakerKeys are both "" so they merge into one paragraph
  // and two people are run together. With the latch they carry labels and break apart.
  eq(joinUtterances([...toUtterances({ text: "Sam says one thing" }, "stt"),
                     ...toUtterances({ text: "Manuela says another" }, "stt")]),
    "Sam says one thing Manuela says another",
    "unlabelled + unlabelled merges — this is the bug, shown here so the fix below has a baseline");
  eq(joinUtterances([
      ...toUtterances({ text: "x", multiSpeaker: true, turns: [{ speaker: "Speaker 1", text: "Sam says one thing" }] }, "stt"),
      ...toUtterances({ text: "x", multiSpeaker: true, turns: [{ speaker: "Speaker 2", text: "Manuela says another" }] }, "stt")]),
    "Speaker 1: Sam says one thing\n\nSpeaker 2: Manuela says another",
    "...and the latch keeps two one-voice chunks in separate paragraphs");
  // An unlabelled chunk after a labelled one still breaks — the Gemini fallback returns no turns,
  // and it must not be absorbed into the last speaker's paragraph.
  eq(joinUtterances([
      ...toUtterances({ text: "x", multiSpeaker: true, turns: [{ speaker: "Speaker 2", text: "hey there" }] }, "stt"),
      ...toUtterances({ text: "fallback text, no turns" }, "stt")]),
    "Speaker 2: hey there\n\nfallback text, no turns",
    "an unlabelled fallback chunk is never attributed to the previous speaker");

  // The FIRST chunk to catch two people is always unlatched — corroboration takes two chunks — so
  // the chunk's own evidence has to be enough on its own, or that exchange goes out unlabelled.
  eq(toUtterances({ text: "x", multiSpeaker: false, turns: [
      { speaker: "Speaker 1", text: "morning" }, { speaker: "Speaker 2", text: "hey" }] }, "stt")
      .map(u => u.speaker),
    ["Speaker 1", "Speaker 2"], "a chunk holding two voices is labelled before the latch corroborates");

  // --- classifyMode: the opening words decide, after markers and filler are peeled off ---
  eq(classifyMode("I need to call the plumber"), "intent", "explicit commitment");
  eq(classifyMode("let's ship it on Friday"), "intent", "collective commitment");
  eq(classifyMode("Remind me to renew the domain"), "intent", "reminder phrasing");
  eq(classifyMode("what if we moved the deadline"), "question", "question cue with no question mark");
  eq(classifyMode("does that even work"), "question", "auxiliary opener");
  eq(classifyMode("the build is broken again?"), "question", "a question mark is enough on its own");
  eq(classifyMode("we shipped the release yesterday"), null, "plain recall marks nothing");
  eq(classifyMode("what I meant was the other repo"), null,
    "a bare wh-opener is NOT a question — this is the false positive the narrow cue list avoids");

  eq(classifyMode("actually the build is fine"), "aside", "shift marker in front of narration");
  eq(classifyMode("actually I need to call him"), "intent",
    "marker is peeled first, so the real content classifies — not swallowed as an aside");
  eq(classifyMode("wait what about the budget"), "question", "marker peeled, question underneath");
  eq(classifyMode("so we merged it"), null, "filler carries no rhetorical weight");
  eq(classifyMode("okay so actually we should ship"), "intent", "peels repeatedly through mixed openers");
  eq(classifyMode("Speaker 2: I need to review that"), "intent",
    "the renderer's speaker prefix does not shadow the cue behind it");

  // --- sentenceUnits: punctuation refines, its absence never blocks ---
  eq(sentenceUnits("one. two! three?"), 3, "terminators counted");
  eq(sentenceUnits("no punctuation at all"), 1, "an unpunctuated utterance is still worth one unit");
  eq(sentenceUnits("he said \"go.\" then left."), 2, "a terminator behind a quote still counts");

  // --- rule 3: gated on the outgoing run, so a lone cue cannot break a young paragraph ---
  eq(breakBefore(open({ words: 10, mode: "narration", sentences: 1 }), say("I need to call him")), "none",
    "mode change is held back while the outgoing run is under MODE_MIN_SENTENCES");
  eq(breakBefore(open({ words: 10, mode: "narration", sentences: 2 }), say("I need to call him")), "paragraph",
    "...and lands once the outgoing run has earned it");
  eq(breakBefore(open({ words: 10, mode: "narration", sentences: 5 }), say("we shipped it")), "none",
    "same mode never breaks, however long the run");
  eq(breakBefore(open({ words: 10, mode: "narration", sentences: 5 }), say("I need to call him"), { detectMode: false }),
    "none", "rule 3 is switchable off");
  eq(breakBefore(open({ speaker: "A", words: 10, mode: "narration", sentences: 5 }), say("I need to", { speaker: "B" })),
    "paragraph", "speaker still outranks mode (both would break here anyway)");

  // Unmarked text continues the run rather than voting for narration — the property the end-to-end
  // case below depends on, and the one whose absence made a continued intent run flip mid-paragraph.
  const run = absorb(open({ words: 10, mode: "intent", sentences: 2 }), say("and book thirty minutes"));
  eq([run.kind, run.open.mode, run.open.sentences], ["none", "intent", 3],
    "an unmarked utterance extends the intent run instead of resetting it to narration");
  eq(absorb(EMPTY_PARAGRAPH, say("just talking")).open.mode, "narration",
    "a fresh paragraph opened by unmarked text starts neutral");

  // Anti-flap: a blocked mode change still adopts the new mode, so the NEXT utterance compares
  // against it rather than against a mode the paragraph left two utterances ago.
  const flap = absorb(open({ words: 10, mode: "narration", sentences: 1 }), say("I need to call him"));
  eq([flap.kind, flap.open.mode, flap.open.sentences], ["none", "intent", 1],
    "blocked mode change restarts the run in the new mode instead of accumulating");

  // --- end to end: a realistic dictated stretch ---
  const dump = joinUtterances([
    say("I spoke to Dana about the migration this morning"),
    say("she thinks the read path is the risky bit"),
    say("I need to write up the rollback plan before Thursday"),
    say("and book thirty minutes with the platform team"),
    say("what if we staged it behind a flag instead"),
  ]);
  eq(dump.split("\n\n").length, 3,
    "narration -> intent -> question reads as three paragraphs, on cue words alone");
  eq(dump.split("\n\n")[1].startsWith("I need to write up"), true,
    "the break lands where the mode actually turns");

  /* --- properties over randomized sequences ---------------------------------------------------
   * The assertions above pin what the rules SAY. These pin what no rule may ever break, whatever
   * combination of speakers, cues, lengths and punctuation turns up — including combinations
   * nobody thought to write a case for. Seeded, so a counterexample is permanent and reproducible
   * rather than a failure that shows up once in CI and never again.
   */

  // mulberry32.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const wordsOf = (t: string) => t.trim().split(/\s+/).filter(Boolean);
  // Weighted toward no opener: most real speech carries no cue, and a generator that cued every
  // utterance would exercise the mode rule far harder than reality does.
  const OPENERS = ["", "", "", "I need to ", "what if ", "actually ", "so ", "we should ", "anyway "];

  const genSequence = (r: () => number): Utterance[] =>
    Array.from({ length: 1 + Math.floor(r() * 20) }, (_, i) => {
      const speakerRoll = r();
      return {
        text: OPENERS[Math.floor(r() * OPENERS.length)]
          + Array.from({ length: 1 + Math.floor(r() * 24) }, (_, j) => `w${i}x${j}`).join(" ")
          + (r() < 0.5 ? "." : ""),
        speaker: speakerRoll < 0.4 ? undefined : `Speaker ${1 + Math.floor(speakerRoll * 3)}`,
        source: "stt" as const,
        startsScene: r() < 0.05 || undefined,
      };
    });

  // Only speaker and scene survive with modes off and the caps out of reach — and neither of those
  // rules reads the text at all.
  const STRUCTURAL: ParagraphOptions = { detectMode: false, softCapWords: 1e9, hardCapWords: 1e9 };
  const kindsOf = (us: Utterance[], opts: ParagraphOptions) => {
    let o = EMPTY_PARAGRAPH;
    return us.map(u => { const r = absorb(o, u, opts); o = r.open; return r.kind; });
  };

  for (let seed = 1; seed <= 300; seed++) {
    const seq = genSequence(rng(seed));
    const at = (m: string) => `${m} [seed ${seed}]`;
    const batch = joinUtterances(seq);

    // Append-only, and incremental == batch. Fed one utterance at a time, exactly as the live app
    // feeds it: the transcript only ever GROWS at the tail. The proofreader splices corrections by
    // character offset behind a `startsWith` prefix guard, so an append that rewrote committed text
    // would silently invalidate every flag it is holding.
    let open = EMPTY_PARAGRAPH;
    let live = "";
    for (const u of seq) {
      const before = live;
      const fold = foldUtterances(open, [u]);
      open = fold.open;
      live = spliceAddition(live, fold.addition);
      eq(live.startsWith(before), true, at("an append rewrote text that was already committed"));
    }
    eq(live, batch, at("appending one at a time disagrees with rendering the batch"));

    // A break may only ever insert whitespace — never drop, duplicate or reorder speech.
    eq(wordsOf(batch), seq.flatMap(u => wordsOf(u.text)), at("text was lost or reordered"));

    // The ceiling holds for every paragraph, not on average. No walls of text, ever.
    eq(batch.split(/\n{2,}/).every(p => wordsOf(p).length <= HARD_CAP_WORDS), true,
      at("a paragraph exceeded the hard cap"));

    // Only the three declared separators reach the renderer.
    eq(/(?<!\n)\n(?!\n)/.test(batch), false, at("a lone newline appeared"));
    eq(/\n{4,}/.test(batch), false, at("a gap wider than a scene break appeared"));

    // Pure: no hidden state accumulates between runs.
    eq(joinUtterances(seq), batch, at("a second run of the same input differed"));

    // THE regression property. Chrome's auto-punctuation is inconsistent, so identical speech
    // arrives punctuated on one run and bare on the next; structural breaks must not notice.
    eq(kindsOf(seq.map(u => ({ ...u, text: u.text.replace(/[.!?]/g, "") })), STRUCTURAL),
      kindsOf(seq, STRUCTURAL),
      at("stripping punctuation moved a structural break"));
  }

  eq(EMPTY_PARAGRAPH, { words: 0, endsSentence: false, mode: "narration", sentences: 0 },
    "EMPTY_PARAGRAPH was mutated by a run");

  /* --- a realistic dictation, chunked the way real recognizers chunk -------------------------- */

  // Lowercase and completely unpunctuated on purpose: the worst case for the rules this replaced,
  // which hung paragraph breaks off a trailing full stop that Chrome supplies only sometimes.
  // `|` marks where a recognizer would have ended one final result and started the next.
  const DUMP = [
    "okay so the kitchen thing um where do i start",
    "contractor dave said he can swing by thursday at two to walk through the space before he quotes anything",
    "i need to be home for that",
    "and i should clear the whole afternoon so i am not rushing him out the door",
    "what if we did the backsplash ourselves instead of paying him for it",
    "actually the tile is the expensive part not the labour",
    "anyway i need to buy grout and two more boxes of tile because i measured wrong the first time",
  ].join(" | ");

  const flat = DUMP.replace(/ \| /g, " ");
  eq(/[.!?]/.test(flat), false, "the fixture is meant to be free of punctuation");

  const spoken = (text: string): Utterance => ({ text, source: "speech" });
  const grid = (text: string, n: number) => {
    const w = wordsOf(text);
    return Array.from({ length: Math.ceil(w.length / n) }, (_, i) => spoken(w.slice(i * n, i * n + n).join(" ")));
  };

  const aligned = joinUtterances(DUMP.split(" | ").map(spoken)).split(/\n{2,}/);
  const oneBlob = joinUtterances([spoken(flat)]).split(/\n{2,}/);
  const eightWord = joinUtterances(grid(flat, 8)).split(/\n{2,}/);

  for (const [name, paras] of [["aligned", aligned], ["blob", oneBlob], ["grid", eightWord]] as const) {
    eq(wordsOf(paras.join(" ")), wordsOf(flat), `${name}: chunking changed the words themselves`);
    eq(paras.every(p => wordsOf(p).length <= HARD_CAP_WORDS), true, `${name}: produced a wall of text`);
  }

  // Utterance-aligned is the case the cue rules are built for: the turns land at chunk starts.
  // narration -> intent ("i need to be home") -> question ("what if we did"). The aside and the
  // final intent do NOT break: the gate wants MODE_MIN_SENTENCES of the outgoing run first, and
  // each had only just started. That is the conservative half of the trade-off, on purpose.
  eq(aligned.length, 3, "utterance-aligned dictation reads as three paragraphs");
  eq(aligned[1].startsWith("i need to be home"), true, "the break lands where the thought turns");
  eq(aligned[2].startsWith("what if we did"), true, "and again at the question");

  // A single long recognizer result is atomic. Nothing can break inside it, because breaks are
  // only ever decided BETWEEN utterances — the append-only rule the proofreader offsets depend on.
  eq(oneBlob.length, 1, "one 90-word result stays one paragraph — a documented limit, not a bug");

  // Cue detection reads the OPENING of an utterance, so a chunk boundary that falls mid-thought
  // hides the cue behind it. A fixed word grid can therefore only ever find FEWER turns than
  // recognizer-aligned chunking — the length caps are what stop it degrading past a wall.
  eq(eightWord.length <= aligned.length, true, "a word grid found more turns than aligned chunking");

  console.log("paragraphs self-check ✓");
}
