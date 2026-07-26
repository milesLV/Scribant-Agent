import { useState, useEffect } from "react";
import { BrainCircuit, Key, Info, Check, CloudLightning, LogOut, FolderSync } from "lucide-react";

interface HeaderProps {
  token: string | null;
  onSetToken: (token: string | null) => void;
  clientId: string;
  onSetClientId: (clientId: string) => void;
  onSignIn: () => void;
  showConfig: boolean;
  onShowConfigChange: (open: boolean) => void;
}

export default function Header({
  token,
  onSetToken,
  clientId,
  onSetClientId,
  onSignIn,
  showConfig,
  onShowConfigChange
}: HeaderProps) {
  const [inputClientId, setInputClientId] = useState(clientId || "");

  useEffect(() => {
    setInputClientId(clientId || "");
  }, [clientId]);

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

      {showConfig && (
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
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

          <div className="pt-2">
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
      )}

    </div>
  );
}
