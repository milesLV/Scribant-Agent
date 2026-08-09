// Skill registry — one entry per kind of item the intent classifier extracts from a transcript.
// /api/analyze generates its responseSchema + prompt criteria from this list, so adding a skill is
// a single array entry instead of edits scattered across a 130-line prompt and a 60-line schema.
//
// Scope note: a Skill here is EXTRACTION only (what the model emits). Execution stays per-item
// behind the client's review-then-act UI (handleExecute* in App.tsx → /api/execute), deliberately
// not a batch loop, so there's no `execute` here. Document-level outputs (ideasSummary) are not
// skills; they live inline in agents.ts.
import { z } from "zod";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";

interface Skill {
  name: string;              // response key AND the client-side bucket it normalizes into
  arrayDescription: string;  // schema-level description of the array
  description: string;       // criteria block injected into the classifier prompt (starts with the type)
  itemSchema: z.ZodObject<z.ZodRawShape>; // Zod schema for ONE item (feeds the ADK agent's outputSchema)
}

const calendarSkill: Skill = {
  name: "calendarEvents",
  arrayDescription: "List of calendar events that should be scheduled.",
  description: `(array of objects) Things that HAPPEN on a timeline — you attend them or they occur over a span of time (appointments, meetings, trips, birthdays). Use a calendar event when the TIME ITSELF matters: either a specific clock time you must be present for ("groomer tomorrow at 9", "dinner with Sam at 7"), OR a whole day/days something occupies even without a clock time ("driving to Yosemite tomorrow", "my sister's birthday Friday"). DO NOT use a calendar event for an action you merely need to finish by some point — that is a task with a dueDate (see #3). DO NOT include vague aspirations (NO to "I want to do better at coding"). Set "uncertain": true when the commitment, date, or time is vague (e.g. "we should grab lunch sometime"), else false. Each object must have:
   - "title": (string) Event summary/title
   - "description": (string) Event description/context
   - "allDay": (boolean) true if it spans whole day(s) with no specific clock time (trips, birthdays, holidays, out-of-office); false for events with a start time.
   - "start": (string) Start as ISO-8601 (use the current local time to resolve "tomorrow", "tonight", "next week"). For all-day events use the date at 00:00.
   - "end": (string) End as ISO-8601. Default to 30 minutes after start when no duration is implied (for all-day, the same day or the stated span).
   - "uncertain": (boolean)
   - "explicitCommand": (boolean) true ONLY when the speaker directly instructs that this be put on their calendar ("add that to my calendar", "schedule it for 5pm", "put it on Google Calendar"). Merely mentioning a plan or appointment ("I'm seeing the dentist tomorrow at 3") is NOT a command — that is false.
   - "sourceText": (string) The exact words from the transcript that triggered this event, copied verbatim (not paraphrased).`,
  itemSchema: z.object({
    title: z.string().describe("Event summary/title"),
    description: z.string().describe("Event description/context"),
    start: z.string().describe("Start time as ISO-8601 string"),
    end: z.string().describe("End time as ISO-8601 string"),
    uncertain: z.boolean().describe("Whether there is uncertainty about the event commitment or details"),
    allDay: z.boolean().describe("True if it spans whole day(s) with no specific clock time"),
    explicitCommand: z.boolean().describe("True only when the speaker directly instructed adding this to their calendar"),
    sourceText: z.string().describe("Verbatim transcript phrase that triggered this event"),
  }),
};

const tasksSkill: Skill = {
  name: "tasks",
  arrayDescription: "Actionable todo checklist items found in the text.",
  description: `(array of objects) Things you DO and check off — actions you can complete at any time rather than at a fixed clock time ("water the plants", "renew my passport", "clean the house before the walk-through", "prepare for my interview"). If the action has a deadline or upper bound, capture it in "dueDate"; if instead it must happen AT a specific time you attend, it is a calendar event. DO NOT include vague moods (NO to "I want my life together" or "I should work on my project"). Set "uncertain": true when the task or its details are vague, else false. Each object must have:
   - "title": (string) Compact title of the task
   - "notes": (string) Any descriptions, sub-items, or context
   - "dueDate": (string) Deadline as an ISO date "YYYY-MM-DD" if the action is bounded ("today", "by Friday", "before the walk-through" — resolve relative to the current local time); empty string "" if open-ended.
   - "uncertain": (boolean) Set to true if the task itself or its details are vague or uncertain, else false.
   - "explicitCommand": (boolean) true ONLY when the speaker directly instructs that this be logged ("add that to my to-do list", "put sweeping on my tasks", "remind me to..."). A plain statement of intent ("I need to sweep the floor") is NOT a command — that is false. Also false if they say NOT to add it yet ("don't add that yet").
   - "sourceText": (string) The exact words from the transcript that triggered this task, copied verbatim (not paraphrased).
GUIDANCE (tasks vs events): prefer a TASK WITH A dueDate over inventing a fake event time. Only make a calendar event when being there at that specific time matters, or when it occupies whole days. A flexible action with just a deadline (e.g. "hit the gym sometime next week") is a task (uncertain) with a dueDate, NOT an event.`,
  itemSchema: z.object({
    title: z.string().describe("Compact title of the task"),
    notes: z.string().describe("Any descriptions, sub-items, or context"),
    uncertain: z.boolean().describe("Whether the task itself or its details are vague or uncertain"),
    dueDate: z.string().describe("Deadline as ISO date YYYY-MM-DD if bounded, else empty string"),
    explicitCommand: z.boolean().describe("True only when the speaker directly instructed logging this to their to-do list"),
    sourceText: z.string().describe("Verbatim transcript phrase that triggered this task"),
  }),
};

const searchSkill: Skill = {
  name: "searchQueries",
  arrayDescription: "Questions or topics they explicitly mentioned searching or finding info on.",
  description: `(array of objects) ONLY include searchable, well-defined questions or queries (e.g. YES to "I wonder what the most efficient gas mileage for my Toyota Sienna is" or "Where is the best place to eat?"). DO NOT include personal, unsearchable thoughts (e.g. NO to "I wonder what I will eat when I get home" or "What do I have in my fridge?"). Each object must have:
   - "query": (string) The search query text
   - "explicitCommand": (boolean) true ONLY when the speaker directly asks for the search to be run ("look that up for me", "search for it", "find out for me"). A passing curiosity ("I wonder who designed the Concorde") is NOT a command — that is false.
   - "sourceText": (string) The exact words from the transcript that triggered this query, copied verbatim (not paraphrased).`,
  itemSchema: z.object({
    query: z.string(),
    explicitCommand: z.boolean().describe("True only when the speaker directly asked for this search to be run"),
    sourceText: z.string().describe("Verbatim transcript phrase that triggered this query"),
  }),
};

// Order matters: the calendar criteria references tasks as "#3", so keep calendar→tasks→search.
export const SKILLS: Skill[] = [calendarSkill, tasksSkill, searchSkill];

// {"calendarEvents": z.array(...), ...} — spread into the analyze agent's Zod outputSchema.
export function skillSchemaProperties(): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(
    SKILLS.map(s => [s.name, z.array(s.itemSchema).describe(s.arrayDescription)])
  );
}

// ponytail: self-check guards the response contract the client depends on. Run: tsx skills.ts
// import.meta.url is empty in the esbuild CJS bundle, so self-checks stay dev-only (prod boot would crash on fileURLToPath(undefined)).
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  const props = skillSchemaProperties();
  assert.deepEqual(Object.keys(props), ["calendarEvents", "tasks", "searchQueries"]);
  assert.ok(props.calendarEvents instanceof z.ZodArray);
  // Zod object fields are required by default — the shape keys ARE the required list.
  assert.deepEqual(
    Object.keys((props.tasks as z.ZodArray<z.ZodObject<z.ZodRawShape>>).element.shape),
    ["title", "notes", "uncertain", "dueDate", "explicitCommand", "sourceText"]
  );
  // tasks must stay index 3 (calendar=2) so the calendar criteria's "(see #3)" reference holds.
  assert.equal(SKILLS.findIndex(s => s.name === "tasks"), 1);
  console.log("skills self-check ✓");
}
