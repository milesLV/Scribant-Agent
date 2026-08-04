// The one predicate that decides whether an item is written to the user's real Google account
// WITHOUT them clicking anything. Lives here rather than inline in App.tsx so it can be pinned by a
// self-check — a wrong operator here schedules things nobody consented to.
import { AutonomyMode } from "../types";

// manual: nothing, ever. consent: only what the speaker explicitly commanded, and only if the model
// was confident about it. auto: anything confident, or literally everything when allowUncertain.
export function isAutoExecutable(
  item: { status: string; uncertain?: boolean; explicitCommand?: boolean },
  mode: AutonomyMode,
  allowUncertain: boolean,
): boolean {
  if (mode === "manual") return false;
  if (item.status !== "pending") return false;
  if (mode === "auto") return allowUncertain || !item.uncertain;
  return !!item.explicitCommand && !item.uncertain;
}

// ponytail: self-check pins the consent gate. Run: tsx src/utils/autonomy.ts
// No node imports — this module ships to the browser, so the check uses a plain throw like transcript.ts.
if (typeof process !== "undefined" && process.argv[1]?.endsWith("autonomy.ts")) {
  const eq = (got: boolean, want: boolean, msg: string) => {
    if (got !== want) throw new Error(`${msg}: want ${want}, got ${got}`);
  };
  const commanded = { status: "pending", explicitCommand: true, uncertain: false };
  const mentioned = { status: "pending", explicitCommand: false, uncertain: false };
  const vague = { status: "pending", explicitCommand: true, uncertain: true };

  // manual never acts, not even on an explicit spoken command
  for (const i of [commanded, mentioned, vague]) eq(isAutoExecutable(i, "manual", true), false, "manual acts");

  // consent: command required, and uncertainty still blocks it
  eq(isAutoExecutable(commanded, "consent", false), true, "consent + command");
  eq(isAutoExecutable(mentioned, "consent", false), false, "consent without command");
  eq(isAutoExecutable(vague, "consent", false), false, "consent + uncertain");
  // allowUncertain is an `auto`-only knob — it must NOT loosen the consent gate
  eq(isAutoExecutable(vague, "consent", true), false, "allowUncertain leaked into consent");
  eq(isAutoExecutable(mentioned, "consent", true), false, "allowUncertain bypassed consent");

  // auto: confidence is the gate, consent is not required
  eq(isAutoExecutable(mentioned, "auto", false), true, "auto + confident");
  eq(isAutoExecutable(vague, "auto", false), false, "auto + uncertain");
  eq(isAutoExecutable(vague, "auto", true), true, "auto + allowUncertain");

  // already-executed items are never re-run, in any mode
  for (const m of ["consent", "auto"] as const)
    eq(isAutoExecutable({ ...commanded, status: "created" }, m, true), false, `re-ran a done item in ${m}`);

  console.log("autonomy self-check ✓");
}
