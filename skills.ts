// Skill registry — one entry per kind of item the intent classifier extracts from a transcript.
// /api/analyze generates its responseSchema + prompt criteria from this list, so adding a skill is
// a single array entry instead of edits scattered across a 130-line prompt and a 60-line schema.
//
// Scope note: a Skill here is EXTRACTION only (what the model emits). Execution stays per-item in
// the client (handleScheduleEvent/handleCreateTask/handleRunSearch in App.tsx) — that review-then-act
// UI is deliberately not a batch loop, so there's no `execute` here. Document-level outputs
// (ideasSummary, organizedFolderName) are not skills; they live inline in server.ts.
import { Type } from "@google/genai";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";

interface Skill {
  name: string;              // response key AND the client-side bucket it normalizes into
  arrayDescription: string;  // schema-level description of the array
  description: string;       // criteria block injected into the classifier prompt (starts with the type)
  itemSchema: any;           // Gemini responseSchema for ONE item
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
   - "sourceText": (string) The exact words from the transcript that triggered this event, copied verbatim (not paraphrased).`,
  itemSchema: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Event summary/title" },
      description: { type: Type.STRING, description: "Event description/context" },
      start: { type: Type.STRING, description: "Start time as ISO-8601 string" },
      end: { type: Type.STRING, description: "End time as ISO-8601 string" },
      uncertain: { type: Type.BOOLEAN, description: "Whether there is uncertainty about the event commitment or details" },
      allDay: { type: Type.BOOLEAN, description: "True if it spans whole day(s) with no specific clock time" },
      sourceText: { type: Type.STRING, description: "Verbatim transcript phrase that triggered this event" },
    },
    required: ["title", "description", "start", "end", "uncertain", "allDay", "sourceText"],
  },
};

const tasksSkill: Skill = {
  name: "tasks",
  arrayDescription: "Actionable todo checklist items found in the text.",
  description: `(array of objects) Things you DO and check off — actions you can complete at any time rather than at a fixed clock time ("water the plants", "renew my passport", "clean the house before the walk-through", "prepare for my interview"). If the action has a deadline or upper bound, capture it in "dueDate"; if instead it must happen AT a specific time you attend, it is a calendar event. DO NOT include vague moods (NO to "I want my life together" or "I should work on my project"). Set "uncertain": true when the task or its details are vague, else false. Each object must have:
   - "title": (string) Compact title of the task
   - "notes": (string) Any descriptions, sub-items, or context
   - "dueDate": (string) Deadline as an ISO date "YYYY-MM-DD" if the action is bounded ("today", "by Friday", "before the walk-through" — resolve relative to the current local time); empty string "" if open-ended.
   - "uncertain": (boolean) Set to true if the task itself or its details are vague or uncertain, else false.
   - "sourceText": (string) The exact words from the transcript that triggered this task, copied verbatim (not paraphrased).
GUIDANCE (tasks vs events): prefer a TASK WITH A dueDate over inventing a fake event time. Only make a calendar event when being there at that specific time matters, or when it occupies whole days. A flexible action with just a deadline (e.g. "hit the gym sometime next week") is a task (uncertain) with a dueDate, NOT an event.`,
  itemSchema: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Compact title of the task" },
      notes: { type: Type.STRING, description: "Any descriptions, sub-items, or context" },
      uncertain: { type: Type.BOOLEAN, description: "Whether the task itself or its details are vague or uncertain" },
      dueDate: { type: Type.STRING, description: "Deadline as ISO date YYYY-MM-DD if bounded, else empty string" },
      sourceText: { type: Type.STRING, description: "Verbatim transcript phrase that triggered this task" },
    },
    required: ["title", "notes", "uncertain", "dueDate", "sourceText"],
  },
};

const searchSkill: Skill = {
  name: "searchQueries",
  arrayDescription: "Questions or topics they explicitly mentioned searching or finding info on.",
  description: `(array of objects) ONLY include searchable, well-defined questions or queries (e.g. YES to "I wonder what the most efficient gas mileage for my Toyota Sienna is" or "Where is the best place to eat?"). DO NOT include personal, unsearchable thoughts (e.g. NO to "I wonder what I will eat when I get home" or "What do I have in my fridge?"). Each object must have:
   - "query": (string) The search query text
   - "sourceText": (string) The exact words from the transcript that triggered this query, copied verbatim (not paraphrased).`,
  itemSchema: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING },
      sourceText: { type: Type.STRING, description: "Verbatim transcript phrase that triggered this query" },
    },
    required: ["query", "sourceText"],
  },
};

// Order matters: the calendar criteria references tasks as "#3", so keep calendar→tasks→search.
export const SKILLS: Skill[] = [calendarSkill, tasksSkill, searchSkill];

// {"calendarEvents": {type: ARRAY, items: ...}, ...} — spread into the analyze responseSchema.
export function skillSchemaProperties(): Record<string, any> {
  return Object.fromEntries(
    SKILLS.map(s => [s.name, { type: Type.ARRAY, description: s.arrayDescription, items: s.itemSchema }])
  );
}

// ponytail: self-check guards the response contract the client depends on. Run: tsx skills.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const props = skillSchemaProperties();
  assert.deepEqual(Object.keys(props), ["calendarEvents", "tasks", "searchQueries"]);
  assert.equal(props.calendarEvents.type, Type.ARRAY);
  assert.deepEqual(
    props.tasks.items.required,
    ["title", "notes", "uncertain", "dueDate", "sourceText"]
  );
  // tasks must stay index 3 (calendar=2) so the calendar criteria's "(see #3)" reference holds.
  assert.equal(SKILLS.findIndex(s => s.name === "tasks"), 1);
  console.log("skills self-check ✓");
}
