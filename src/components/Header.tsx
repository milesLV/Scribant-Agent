import { useState, useEffect, useRef } from "react";
import { BrainCircuit, Key, Info, Check, CloudLightning, LogOut, FolderSync, X, Terminal } from "lucide-react";
import { AutonomyMode } from "../types";

interface HeaderProps {
  token: string | null;
  onSetToken: (token: string | null) => void;
  clientId: string;
  onSetClientId: (clientId: string) => void;
  onSignIn: () => void;
  showConfig: boolean;
  onShowConfigChange: (open: boolean) => void;
  autonomyMode: AutonomyMode;
  onSetAutonomyMode: (mode: AutonomyMode) => void;
  allowUncertain: boolean;
  onSetAllowUncertain: (allow: boolean) => void;
  autoRun: boolean;
  onAutoRunChange: (on: boolean) => void;
  showDebugPanel?: boolean;
  onToggleDebugPanel?: () => void;
  eventsCount?: number;
}

const AUTONOMY_OPTIONS: { mode: AutonomyMode; label: string; description: string }[] = [
  { mode: "manual", label: "Completely Manual", description: "Nothing is ever added automatically — you press every button yourself, even when you say so out loud." },
  { mode: "consent", label: "On Your Command", description: "The agent acts only when you explicitly say so (\"add that to my to-do list\"); everything else waits for a click." },
  { mode: "auto", label: "Fully Autonomous", description: "Anything confidently identified is added to your workspace on its own; uncertain items still wait for review." },
];

export default function Header({
  token,
  onSetToken,
  clientId,
  onSetClientId,
  onSignIn,
  showConfig,
  onShowConfigChange,
  autonomyMode,
  onSetAutonomyMode,
  allowUncertain,
  onSetAllowUncertain,
  autoRun,
  onAutoRunChange,
  showDebugPanel,
  onToggleDebugPanel,
  eventsCount = 0,
}: HeaderProps) {
  const [inputClientId, setInputClientId] = useState(clientId || "");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setInputClientId(clientId || "");
  }, [clientId]);

  // <dialog>.showModal() gives Escape-to-close, the backdrop and a focus trap for free.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (showConfig && !d.open) d.showModal();
    if (!showConfig && d.open) d.close();
  }, [showConfig]);

  const handleSaveClientId = () => {
    onSetClientId(inputClientId.trim());
    onShowConfigChange(false);
  };

  const currentRedirectUri = window.location.origin;

  return (
    <div id="app-header-container" className="space-y-4">

      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-4 border-b border-stone-200">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-600">
            <BrainCircuit className="w-6 h-6" />
          </div>
          <div className="space-y-0.5">
            <h1 className="text-base font-extrabold tracking-tight font-sans text-stone-800">Scribant</h1>
            <p className="text-[11px] text-stone-500 font-sans">Listen to unfiltered thinking streams, transcribe, and run Google Workspace actions</p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-between sm:justify-end">
          {onToggleDebugPanel && (
            <button
              type="button"
              onClick={onToggleDebugPanel}
              title="Toggle Memory Events Debug Panel"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer font-mono ${
                showDebugPanel
                  ? "bg-amber-100/80 border-amber-300 text-amber-900 shadow-2xs"
                  : "bg-white hover:bg-stone-50 text-stone-600 border-stone-200 hover:text-stone-800"
              }`}
            >
              <Terminal className="w-3.5 h-3.5 text-amber-600" />
              <span>Events Debug</span>
              {eventsCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-900 text-stone-100 font-mono font-bold">
                  {eventsCount}
                </span>
              )}
            </button>
          )}

          {!token && (
            <button
              onClick={onSignIn}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg border bg-stone-900 hover:bg-stone-800 text-white border-stone-950 shadow-sm transition-all"
            >
              <FolderSync className="w-3.5 h-3.5" /> Sign in with Google
            </button>
          )}
          <button
            onClick={() => onShowConfigChange(!showConfig)}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
              token
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-white hover:bg-stone-50 text-stone-600 border-stone-200"
            }`}
          >
            {token ? (
              <>
                <CloudLightning className="w-3.5 h-3.5 text-emerald-600" /> Workspace Online
              </>
            ) : (
              <>
                <Key className="w-3.5 h-3.5" /> Settings
              </>
            )}
          </button>
        </div>
      </header>

      <dialog
        ref={dialogRef}
        aria-label="Settings"
        onClose={() => onShowConfigChange(false)}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onShowConfigChange(false); }}
        // m-auto: Tailwind's preflight zeroes margins, which kills <dialog>'s default centering.
        className="w-full max-w-2xl m-auto rounded-2xl bg-transparent p-0 backdrop:bg-stone-900/40 backdrop:backdrop-blur-[2px]"
      >
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xl space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="p-1.5 bg-stone-100 border border-stone-200 rounded-lg text-stone-600 mt-0.5">
                <Info className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <h3 className="text-xs font-bold text-stone-800 uppercase tracking-wider font-mono">Workspace Integration Settings</h3>
                <p className="text-xs text-stone-500 leading-relaxed font-sans">
                  By default Scribant runs in <strong>Sandbox Mode (simulated Google APIs)</strong>. Click <strong>Sign in with Google</strong> to use real Calendar and Tasks. To sign in against your own Google Cloud project, set its OAuth Web Client ID below — its authorized redirect URI must match the address shown.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onShowConfigChange(false)}
              aria-label="Close settings"
              className="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-stone-600 font-sans block">Consent &amp; Autonomy:</label>
            <div className="flex items-start gap-4">
              <div className="flex-1 grid grid-cols-3">
                {AUTONOMY_OPTIONS.map(opt => (
                  <label
                    key={opt.mode}
                    className={`border border-stone-200 px-3 py-2.5 cursor-pointer transition-colors ${
                      autonomyMode === opt.mode ? "bg-amber-50/40" : "hover:bg-stone-50"
                    }`}
                  >
                    <span className={`block -mx-3 -mt-2.5 mb-2 px-3 py-2 border-b border-stone-200 text-[11px] font-bold font-sans ${
                      autonomyMode === opt.mode ? "bg-amber-50 text-amber-900" : "bg-stone-50 text-stone-700"
                    }`}>
                      {opt.label}
                    </span>
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="autonomy-mode"
                        checked={autonomyMode === opt.mode}
                        onChange={() => onSetAutonomyMode(opt.mode)}
                        className="mt-0.5 accent-amber-600 shrink-0"
                      />
                      <span className="text-[10.5px] text-stone-500 leading-relaxed font-sans">{opt.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {autonomyMode === "auto" && (
                <label className="flex flex-col items-end gap-2 pt-2 cursor-pointer shrink-0 w-40">
                  <input
                    type="checkbox"
                    checked={allowUncertain}
                    onChange={(e) => onSetAllowUncertain(e.target.checked)}
                    className="accent-amber-600"
                  />
                  <span className="text-[10.5px] font-semibold text-stone-600 font-sans text-right">Include uncertain items</span>
                </label>
              )}
            </div>
            {/* Lives here rather than above the live notes so that panel's header can hold the
                Drive button. It is the only brake on the live pipeline's token spend. */}
            <label className="flex items-center gap-2 pt-1 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={autoRun}
                onChange={(e) => onAutoRunChange(e.target.checked)}
                className="accent-amber-600"
              />
              <span className="text-[10.5px] font-semibold text-stone-600 font-sans">
                Auto-run live notes while you speak
                <span className="font-normal text-stone-400"> — off means the sparkles button runs it on demand</span>
              </span>
            </label>
          </div>

          <div className="pt-1">
            <div className="space-y-1.5 max-w-md">
              <label className="text-xs font-bold text-stone-600 font-sans block">Google OAuth Client ID:</label>
              <input
                type="text"
                value={inputClientId}
                onChange={(e) => setInputClientId(e.target.value)}
                placeholder="Google OAuth Web Client ID..."
                className="w-full bg-stone-50 border border-stone-200 focus:bg-white rounded-lg p-2.5 text-xs text-stone-700 font-mono outline-none focus:ring-1 focus:ring-amber-500/20"
              />
              <span className="text-[10px] text-stone-400 block font-sans">
                Authorized redirect URI: <code className="bg-stone-100 px-1.5 py-0.5 rounded text-amber-700 font-mono text-[9px]">{currentRedirectUri}</code>
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-stone-100">
            <span className="text-[10.5px] font-semibold text-amber-800 bg-amber-50/55 px-2.5 py-1 rounded border border-amber-100 flex items-center gap-1 font-mono">
              Status: {token ? "Real Google APIs linked" : "Offline sandbox simulation"}
            </span>

            <div className="flex gap-2">
              {token && (
                <button
                  type="button"
                  onClick={() => onSetToken(null)}
                  className="px-3 py-1.5 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors border border-red-200/50 flex items-center gap-1 shrink-0"
                >
                  <LogOut className="w-3 h-3" /> Disconnect
                </button>
              )}
              <button
                type="button"
                onClick={handleSaveClientId}
                className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold px-4 py-1.5 rounded-lg border border-stone-950 shadow flex items-center gap-1.5 transition-colors"
              >
                <Check className="w-3.5 h-3.5" /> Save
              </button>
            </div>
          </div>
        </div>
      </dialog>

    </div>
  );
}
