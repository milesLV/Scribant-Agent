import { useState, useEffect } from "react";
import { Sparkles, BrainCircuit, Key, Info, Check, CloudLightning, ShieldAlert, LogOut } from "lucide-react";

interface HeaderProps {
  token: string | null;
  onSetToken: (token: string | null) => void;
  clientId: string;
  onSetClientId: (clientId: string) => void;
}

export default function Header({
  token,
  onSetToken,
  clientId,
  onSetClientId
}: HeaderProps) {
  const [showConfig, setShowConfig] = useState(false);
  const [inputToken, setInputToken] = useState(token || "");
  const [inputClientId, setInputClientId] = useState(clientId || "");

  useEffect(() => {
    setInputToken(token || "");
  }, [token]);

  useEffect(() => {
    setInputClientId(clientId || "");
  }, [clientId]);

  const handleSaveConfigs = () => {
    onSetToken(inputToken.trim() || null);
    onSetClientId(inputClientId.trim());
    setShowConfig(false);
  };

  const handleDisconnect = () => {
    onSetToken(null);
    setInputToken("");
  };

  const currentRedirectUri = window.location.origin;

  return (
    <div id="app-header-container" className="space-y-4">
      
      {/* Simplified, clean minimal header row */}
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-4 border-b border-stone-200">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-600">
            <BrainCircuit className="w-6 h-6" />
          </div>
          <div className="space-y-0.5">
            <h1 className="text-base font-extrabold tracking-tight font-sans text-stone-800 flex items-center gap-1.5">
              Scribant <span className="text-[9px] bg-amber-100 text-amber-800 font-mono font-medium border border-amber-250/30 px-1.5 py-0.5 rounded-full">v1.1</span>
            </h1>
            <p className="text-[11px] text-stone-500 font-sans">Listen to unfiltered thinking streams, transcribe, and run Google Workspace actions</p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto shrink-0 justify-between sm:justify-end">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
              token 
                ? "bg-emerald-50 border-emerald-200 text-emerald-700" 
                : "bg-stone-900 hover:bg-stone-800 text-white border-stone-950 shadow-sm"
            }`}
          >
            {token ? (
              <>
                <CloudLightning className="w-3.5 h-3.5 text-emerald-600" /> Workspace Online
              </>
            ) : (
              <>
                <Key className="w-3.5 h-3.5" /> Configure Google APIs
              </>
            )}
          </button>
        </div>
      </header>

      {/* Interactive API/OAuth configurator */}
      {showConfig && (
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-start gap-2.5">
            <div className="p-1.5 bg-stone-100 border border-stone-200 rounded-lg text-stone-600 mt-0.5">
              <Info className="w-4 h-4" />
            </div>
            <div className="space-y-1">
              <h3 className="text-xs font-bold text-stone-800 uppercase tracking-wider font-mono">Workspace Integration Settings</h3>
              <p className="text-xs text-stone-500 leading-relaxed font-sans">
                By default, this agent runs in <strong>Sandbox Mode (Simulated Google APIs)</strong> so you can experience full capabilities immediately without GCP client keys. Switch to **Real Integration Mode** by putting an access token or Client ID below!
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            
            {/* Field: Access Token */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-stone-600 font-sans block">Google OAuth Access Token:</label>
              <input
                type="password"
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
                placeholder="Paste ya29. accessToken directly..."
                className="w-full bg-stone-50 border border-stone-200 focus:bg-white rounded-lg p-2.5 text-xs text-stone-700 font-mono outline-none focus:ring-1 focus:ring-amber-500/20"
              />
              <span className="text-[10px] text-stone-400 block font-sans">
                Easy approach: Copy-paste ya29... token from the Google OAuth Playground or GCP, or inspect the console.
              </span>
            </div>

            {/* Field: GCP Client ID */}
            <div className="space-y-1.55">
              <label className="text-xs font-bold text-stone-600 font-sans block">Custom GCP Client ID (Optional):</label>
              <input
                type="text"
                value={inputClientId}
                onChange={(e) => setInputClientId(e.target.value)}
                placeholder="Google Oauth Web Client ID..."
                className="w-full bg-stone-50 border border-stone-200 focus:bg-white rounded-lg p-2.5 text-xs text-stone-700 font-mono outline-none focus:ring-1 focus:ring-amber-500/20"
              />
              <span className="text-[10px] text-stone-400 block font-sans">
                Redirect URL: <code className="bg-stone-100 px-1.5 py-0.5 rounded text-amber-700 font-mono text-[9px]">{currentRedirectUri}</code>
              </span>
            </div>

          </div>

          <div className="flex items-center justify-between pt-3 border-t border-stone-100">
            <span className="text-[10.5px] font-semibold text-amber-800 bg-amber-50/55 px-2.5 py-1 rounded border border-amber-100 flex items-center gap-1 font-mono">
              Status: {token ? "Real Google APIs Linked" : "Offline Sandbox simulation"}
            </span>

            <div className="flex gap-2">
              {token && (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="px-3 py-1.5 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors border border-red-200/50 flex items-center gap-1 shrink-0"
                >
                  <LogOut className="w-3 h-3" /> Disconnect APIs
                </button>
              )}
              <button
                type="button"
                onClick={handleSaveConfigs}
                className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold px-4 py-1.5 rounded-lg border border-stone-950 shadow flex items-center gap-1.5 transition-colors"
              >
                <Check className="w-3.5 h-3.5" /> Save Configuration
              </button>
            </div>
          </div>

        </div>
      )}

    </div>
  );
}
