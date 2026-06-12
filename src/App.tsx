import { useState, useEffect, useRef } from "react";
import Header from "./components/Header";
import AudioRecorder from "./components/AudioRecorder";
import ActiveSession from "./components/ActiveSession";
import SessionHistory from "./components/SessionHistory";
import { StreamRun, CalendarEvent, TaskItem, DriveDocItem, AnalysisResult } from "./types";
import { 
  createDriveFolder, 
  uploadDriveFile, 
  createCalendarEvent, 
  createGoogleTask,
  resetSandboxState
} from "./utils/google-apis";
import { Check, Info, Lock, Play, ShieldAlert, Sparkles, FolderSync, RefreshCw, Trash2 } from "lucide-react";

export default function App() {
  const [token, setToken] = useState<string | null>(() => {
    const storedToken = localStorage.getItem("gcp_access_token");
    const storedExpiry = localStorage.getItem("gcp_access_token_expiry");
    if (storedToken && storedExpiry) {
      const expiryTime = parseInt(storedExpiry, 10);
      if (Date.now() < expiryTime) {
        return storedToken;
      } else {
        localStorage.removeItem("gcp_access_token");
        localStorage.removeItem("gcp_access_token_expiry");
      }
    }
    return null;
  });
  const [clientId, setClientId] = useState<string>(() => {
    return localStorage.getItem("gcp_client_id") || "";
  });
  const [runs, setRuns] = useState<StreamRun[]>(() => {
    const data = localStorage.getItem("stream_runs_archive");
    return data ? JSON.parse(data) : [];
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const data = localStorage.getItem("stream_runs_archive");
    if (!data) return null;
    const parsed: StreamRun[] = JSON.parse(data);
    return parsed.length > 0 ? parsed[0].id : null;
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [clearSignal, setClearSignal] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [liveDraft, setLiveDraft] = useState<AnalysisResult | null>(null);
  const [liveSummary, setLiveSummary] = useState("");
  const [isMicActive, setIsMicActive] = useState(false);
  const [isLiveAnalyzing, setIsLiveAnalyzing] = useState(false);
  const isLiveAnalyzingRef = useRef(false);

  const lastAnalyzedTextRef = useRef("");
  const lastAnalyzedTimeRef = useRef(0);
  const liveAnalysisTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 5000);
  };

  const handleSetToken = (newToken: string | null) => {
    setToken(newToken);
    if (newToken) {
      localStorage.setItem("gcp_access_token", newToken);
      if (!localStorage.getItem("gcp_access_token_expiry")) {
        const expiryTime = Date.now() + 3600 * 1000;
        localStorage.setItem("gcp_access_token_expiry", expiryTime.toString());
      }
    } else {
      localStorage.removeItem("gcp_access_token");
      localStorage.removeItem("gcp_access_token_expiry");
    }
  };

  // Authenticate implicitly on URL redirect hash matching
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get("access_token");
      const expiresIn = params.get("expires_in") || "3600";
      if (accessToken) {
        const expiryTime = Date.now() + parseInt(expiresIn, 10) * 1000;
        localStorage.setItem("gcp_access_token", accessToken);
        localStorage.setItem("gcp_access_token_expiry", expiryTime.toString());
        setToken(accessToken);
        showToast("Connected successfully! Google Workspace integration is now ONLINE.");
        // Clear secret hash parameters from browser history
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }, []);

  // Monitor token expiration periodically
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      const storedExpiry = localStorage.getItem("gcp_access_token_expiry");
      if (storedExpiry) {
        const expiryTime = parseInt(storedExpiry, 10);
        if (Date.now() >= expiryTime) {
          handleSetToken(null);
          showToast("Your Google session has expired. Reverted to Sandbox Preview Mode.");
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [token]);

  // Sync state to local storage
  useEffect(() => {
    localStorage.setItem("stream_runs_archive", JSON.stringify(runs));
  }, [runs]);

  useEffect(() => {
    if (clientId) {
      localStorage.setItem("gcp_client_id", clientId);
    } else {
      localStorage.removeItem("gcp_client_id");
    }
  }, [clientId]);

  // Debounced and periodic live analysis whenever transcript changes
  useEffect(() => {
    const textToAnalyze = liveTranscript.trim();

    // No content — reset state
    if (!textToAnalyze) {
      setLiveDraft(null);
      lastAnalyzedTextRef.current = "";
      if (liveAnalysisTimerRef.current) {
        clearTimeout(liveAnalysisTimerRef.current);
        liveAnalysisTimerRef.current = null;
      }
      return;
    }

    // Too short to bother analyzing
    if (textToAnalyze.length < 15) {
      return;
    }

    // Text hasn't changed since last completed analysis — nothing to do
    if (textToAnalyze === lastAnalyzedTextRef.current) {
      return;
    }

    // Clear any pending timer
    if (liveAnalysisTimerRef.current) {
      clearTimeout(liveAnalysisTimerRef.current);
      liveAnalysisTimerRef.current = null;
    }

    const runAnalysis = async () => {
      if (isLiveAnalyzingRef.current) return;
      isLiveAnalyzingRef.current = true;
      setIsLiveAnalyzing(true);

      // Cancel previous in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Snapshot what we're analyzing so we can mark it done
      const capturedText = textToAnalyze;
      lastAnalyzedTextRef.current = capturedText;
      lastAnalyzedTimeRef.current = Date.now();

      try {
        const currentLocalTime = new Date().toISOString();
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: capturedText, currentLocalTime, liveSummary }),
          signal: controller.signal
        });

        if (res.ok) {
          const rawRes = await res.json();
          const analysis: AnalysisResult = {
            summary: rawRes.ideasSummary || "",
            rawText: capturedText,
            calendarEvents: (rawRes.calendarEvents || [])
              .filter((evt: any) => evt && evt.title && evt.title.trim() !== "")
              .map((evt: any) => ({
                ...evt,
                status: "pending" as const,
                uncertain: !!evt.uncertain
              })),
            tasks: (rawRes.tasks || [])
              .filter((t: any) => t && t.title && t.title.trim() !== "")
              .map((t: any) => ({
                ...t,
                status: "pending" as const,
                uncertain: !!t.uncertain
              })),
            searchQueries: (rawRes.searchQueries || [])
              .filter((q: any) => q && q.query && q.query.trim() !== "")
              .map((q: any) => ({
                ...q,
                status: "pending" as const
              })),
            organizedFolder: rawRes.organizedFolderName || "Consciousness Report",
            driveDocs: []
          };
          setLiveDraft(analysis);
        }
      } catch (error: any) {
        if (error.name !== "AbortError") {
          console.error("Live draft analysis failed:", error);
        }
      } finally {
        isLiveAnalyzingRef.current = false;
        setIsLiveAnalyzing(false);
      }
    };

    const timeSinceLastRun = Date.now() - lastAnalyzedTimeRef.current;

    if (timeSinceLastRun >= 3000) {
      // Enough time has passed — run immediately
      runAnalysis();
    } else {
      // Debounce: wait 2 seconds after the last transcript change
      liveAnalysisTimerRef.current = setTimeout(() => {
        runAnalysis();
      }, 2000);
    }

    return () => {
      if (liveAnalysisTimerRef.current) {
        clearTimeout(liveAnalysisTimerRef.current);
      }
    };
  }, [liveTranscript, liveSummary]);

  // Sync selectedRunId to live-draft or fallback to archive
  useEffect(() => {
    const text = liveTranscript.trim();
    const selectedRun = runs.find(r => r.id === selectedRunId);
    const isShowingFinalizedRun = selectedRun && selectedRun.rawText.trim() === text;

    if (text) {
      if (!isShowingFinalizedRun && selectedRunId !== "live-draft") {
        setSelectedRunId("live-draft");
      }
    } else {
      if (selectedRunId === "live-draft") {
        setSelectedRunId(runs.length > 0 ? runs[0].id : null);
      }
    }
  }, [liveTranscript, selectedRunId, runs]);

  const handleSetClientId = (id: string) => {
    setClientId(id);
    showToast("GCP Client Credentials configured.");
  };

  const handleGoogleSignIn = () => {
    const activeClientId = clientId || "710834371714-38ghkgl23o93f0b2f5geffb648082980.apps.googleusercontent.com"; // Standard fallback client id
    const redirectUri = window.location.origin;
    const scope = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile";
    
    // Construct standard Implicit Grant Flow auth URL
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${activeClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&include_granted_scopes=true&prompt=consent`;
    
    window.location.href = googleAuthUrl;
  };

  // Perform Gemini analysis on text input
  const handleAnalyzeStream = async (text: string) => {
    setIsProcessing(true);
    
    // Stop any active live fetches
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    try {
      const currentLocalTime = new Date().toISOString();
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text, currentLocalTime, liveSummary })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Brain dump categorization failed.");
      }

      const rawRes = await res.json();

      const analysis: AnalysisResult = {
        summary: rawRes.ideasSummary || "",
        rawText: text,
        calendarEvents: (rawRes.calendarEvents || [])
          .filter((evt: any) => evt && evt.title && evt.title.trim() !== "")
          .map((evt: any) => ({
            ...evt,
            status: "pending" as const,
            uncertain: !!evt.uncertain
          })),
        tasks: (rawRes.tasks || [])
          .filter((t: any) => t && t.title && t.title.trim() !== "")
          .map((t: any) => ({
            ...t,
            status: "pending" as const,
            uncertain: !!t.uncertain
          })),
        searchQueries: (rawRes.searchQueries || [])
          .filter((q: any) => q && q.query && q.query.trim() !== "")
          .map((q: any) => ({
            ...q,
            status: "pending" as const
          })),
        organizedFolder: rawRes.organizedFolderName || "Consciousness Report",
        driveDocs: []
      };

      analysis.driveDocs = [
        {
          name: "1_Stream_Summary.md",
          content: `# Brain Dump Summary Report\n\nGenerated on: ${new Date().toLocaleString()}\n\n## Summary Bulletin\n${analysis.summary}\n\n## Unfiltered thoughts:\n"${text}"`,
          mimeType: "text/markdown",
          type: "summary",
          status: "pending"
        },
        {
          name: "2_Extracted_Insights.md",
          content: `# Extracted Ideas & Insights\n\nBelow are summarized thoughts and bullet points captured from your stream of consciousness:\n\n${analysis.summary}`,
          mimeType: "text/markdown",
          type: "ideas",
          status: "pending"
        }
      ];

      const newRun: StreamRun = {
        id: `run-${Date.now()}`,
        timestamp: new Date().toISOString(),
        rawText: text,
        status: "completed",
        analysis
      };

      setRuns(prev => [newRun, ...prev]);
      setSelectedRunId(newRun.id);
      
      // Clear live draft and transcript so no more tokens are consumed after finalization!
      setLiveTranscript("");
      setLiveDraft(null);
      setLiveSummary("");
      
      showToast("Consciousness stream structured! Actionable items detected.");
    } catch (error: any) {
      console.error(error);
      showToast(`Analyzer Error: ${error.message || "Failed to process speech intents."}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // 1. Google Calendar Integration dispatcher
  const handleExecuteCalendar = async (index: number) => {
    const isLiveDraft = selectedRunId === "live-draft";
    const run = isLiveDraft 
      ? { id: "live-draft", analysis: liveDraft } 
      : runs.find(r => r.id === selectedRunId);

    if (!run || !run.analysis) return;

    const event = run.analysis.calendarEvents[index];
    try {
      const eventId = await createCalendarEvent(token, event);
      
      // Update local state logging hook
      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          const updatedEvents = [...prev.calendarEvents];
          updatedEvents[index] = { ...event, status: "scheduled", eventId };
          return { ...prev, calendarEvents: updatedEvents };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            const updatedEvents = [...r.analysis.calendarEvents];
            updatedEvents[index] = { ...event, status: "scheduled", eventId };
            return { ...r, analysis: { ...r.analysis, calendarEvents: updatedEvents } };
          }
          return r;
        }));
      }

      showToast(`Successfully scheduled "${event.title}" on Google Calendar!`);
    } catch (err: any) {
      console.error(err);
      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          const updatedEvents = [...prev.calendarEvents];
          updatedEvents[index] = { ...event, status: "failed", error: err.message };
          return { ...prev, calendarEvents: updatedEvents };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            const updatedEvents = [...r.analysis.calendarEvents];
            updatedEvents[index] = { ...event, status: "failed", error: err.message };
            return { ...r, analysis: { ...r.analysis, calendarEvents: updatedEvents } };
          }
          return r;
        }));
      }
      showToast(`Calendar Integration Failed: ${err.message}`);
    }
  };

  const handleUpdateCalendar = (index: number, updated: CalendarEvent) => {
    const isLiveDraft = selectedRunId === "live-draft";
    if (isLiveDraft) {
      setLiveDraft(prev => {
        if (!prev) return null;
        const updatedEvents = [...prev.calendarEvents];
        updatedEvents[index] = updated;
        return { ...prev, calendarEvents: updatedEvents };
      });
    } else {
      setRuns(prev => prev.map(r => {
        if (r.id === selectedRunId && r.analysis) {
          const updatedEvents = [...r.analysis.calendarEvents];
          updatedEvents[index] = updated;
          return { ...r, analysis: { ...r.analysis, calendarEvents: updatedEvents } };
        }
        return r;
      }));
    }
  };

  const handleUpdateTask = (index: number, updated: TaskItem) => {
    const isLiveDraft = selectedRunId === "live-draft";
    if (isLiveDraft) {
      setLiveDraft(prev => {
        if (!prev) return null;
        const updatedTasks = [...prev.tasks];
        updatedTasks[index] = updated;
        return { ...prev, tasks: updatedTasks };
      });
    } else {
      setRuns(prev => prev.map(r => {
        if (r.id === selectedRunId && r.analysis) {
          const updatedTasks = [...r.analysis.tasks];
          updatedTasks[index] = updated;
          return { ...r, analysis: { ...r.analysis, tasks: updatedTasks } };
        }
        return r;
      }));
    }
  };

  // 2. Google Tasks Integration dispatcher
  const handleExecuteTask = async (index: number) => {
    const isLiveDraft = selectedRunId === "live-draft";
    const run = isLiveDraft 
      ? { id: "live-draft", analysis: liveDraft } 
      : runs.find(r => r.id === selectedRunId);

    if (!run || !run.analysis) return;

    const task = run.analysis.tasks[index];
    try {
      const taskId = await createGoogleTask(token, task);

      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          const updatedTasks = [...prev.tasks];
          updatedTasks[index] = { ...task, status: "created", taskId };
          return { ...prev, tasks: updatedTasks };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            const updatedTasks = [...r.analysis.tasks];
            updatedTasks[index] = { ...task, status: "created", taskId };
            return { ...r, analysis: { ...r.analysis, tasks: updatedTasks } };
          }
          return r;
        }));
      }

      showToast(`Successfully logged task "${task.title}" to Google Tasks list!`);
    } catch (err: any) {
      console.error(err);
      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          const updatedTasks = [...prev.tasks];
          updatedTasks[index] = { ...task, status: "failed", error: err.message };
          return { ...prev, tasks: updatedTasks };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            const updatedTasks = [...r.analysis.tasks];
            updatedTasks[index] = { ...task, status: "failed", error: err.message };
            return { ...r, analysis: { ...r.analysis, tasks: updatedTasks } };
          }
          return r;
        }));
      }
      showToast(`Tasks Integration Failed: ${err.message}`);
    }
  };

  // 3. Grounded Gemini Search query dispatcher
  const handleExecuteSearch = async (index: number) => {
    const isLiveDraft = selectedRunId === "live-draft";
    const run = isLiveDraft 
      ? { id: "live-draft", analysis: liveDraft } 
      : runs.find(r => r.id === selectedRunId);

    if (!run || !run.analysis) return;

    const queryItem = run.analysis.searchQueries[index];
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: queryItem.query })
      });

      if (!res.ok) {
        throw new Error("Grounded search request returned bad response status.");
      }

      const data = await res.json();
      
      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          const updatedQueries = [...prev.searchQueries];
          updatedQueries[index] = {
            query: queryItem.query,
            status: "completed",
            answer: data.answer,
            sources: data.sources
          };
          return { ...prev, searchQueries: updatedQueries };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            const updatedQueries = [...r.analysis.searchQueries];
            updatedQueries[index] = {
              query: queryItem.query,
              status: "completed",
              answer: data.answer,
              sources: data.sources
            };
            return { ...prev, searchQueries: updatedQueries };
          }
          return r;
        }));
      }

      showToast(`Researced facts retrieved for query: "${queryItem.query}"`);
    } catch (err: any) {
      console.error(err);
      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          const updatedQueries = [...prev.searchQueries];
          updatedQueries[index] = {
            query: queryItem.query,
            status: "failed",
            error: err.message
          };
          return { ...prev, searchQueries: updatedQueries };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            const updatedQueries = [...r.analysis.searchQueries];
            updatedQueries[index] = {
              query: queryItem.query,
              status: "failed",
              error: err.message
            };
            return { ...prev, searchQueries: updatedQueries };
          }
          return r;
        }));
      }
      showToast(`Facts query search failed: ${err.message}`);
    }
  };

  // 4. Google Drive folder & files organization dispatcher
  const handleExecuteDrive = async () => {
    const isLiveDraft = selectedRunId === "live-draft";
    const run = isLiveDraft 
      ? { id: "live-draft", analysis: liveDraft } 
      : runs.find(r => r.id === selectedRunId);

    if (!run || !run.analysis) return;

    const folderName = run.analysis.organizedFolder || "Stream Consciousness Report";

    try {
      // Step 1: Create the parent category folder
      const folderId = await createDriveFolder(token, folderName);

      // Step 2: Formulate dynamic Action report log document
      const actLogsContent = `# Actions & Tasks Log Report\n\nGenerated on: ${new Date().toLocaleString()}\n\n## Actionable checklist saved:\n${
        run.analysis.tasks.map(t => `- [x] ${t.title}: ${t.notes || 'No description'}`).join('\n') || "No tasks recorded."
      }\n\n## Scheduled Appointments:\n${
        run.analysis.calendarEvents.map(e => `- **${e.title}**: ${e.start} to ${e.end}`).join('\n') || "No appointments registered."
      }`;

      const documentsToUpload: Omit<DriveDocItem, "status">[] = [
        ...run.analysis.driveDocs.map(d => ({ name: d.name, content: d.content, mimeType: d.mimeType, type: d.type })),
        { name: "3_Action_Log_Report.md", content: actLogsContent, mimeType: "text/markdown", type: "report" }
      ];

      const uploadedDocs: DriveDocItem[] = [];

      // Step 3: Sequentially upload files into folder
      for (const doc of documentsToUpload) {
        const fileId = await uploadDriveFile(token, doc.name, doc.content, folderId);
        uploadedDocs.push({
          ...doc,
          status: "created" as const,
          fileId,
          folderId
        });
      }

      if (isLiveDraft) {
        setLiveDraft(prev => {
          if (!prev) return null;
          return {
            ...prev,
            driveDocs: uploadedDocs
          };
        });
      } else {
        setRuns(prev => prev.map(r => {
          if (r.id === selectedRunId && r.analysis) {
            return {
              ...r,
              analysis: {
                ...r.analysis,
                driveDocs: uploadedDocs
              }
            };
          }
          return r;
        }));
      }

      showToast(`Organized all documents successfully inside Drive folder "${folderName}"!`);
    } catch (err: any) {
      console.error(err);
      showToast(`Drive Organization failed: ${err.message}`);
    }
  };

  const handleClearAll = () => {
    if (window.confirm("Are you sure you want to clear everything? This will reset the transcript, AI notes, bulletins, calendar events, search queries, and to-dos.")) {
      // Abort any ongoing fetches or analysis requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      // Reset state
      setRuns([]);
      setSelectedRunId(null);
      setClearSignal(prev => prev + 1);
      setLiveTranscript("");
      setLiveDraft(null);
      setLiveSummary("");
      setIsProcessing(false);
      setIsLiveAnalyzing(false);
      isLiveAnalyzingRef.current = false;
      resetSandboxState();
      showToast("All session data cleared.");
    }
  };

  const handleClearSandbox = () => {
    if (window.confirm("Are you sure you want to completely reset the Offline Sandbox database (clears mockup files, events & tasks)?")) {
      resetSandboxState();
      setRuns([]);
      setSelectedRunId(null);
      showToast("Offline Sandbox data database reset successfully.");
    }
  };

  const selectedRun = runs.find(r => r.id === selectedRunId);

  const displayedRun: StreamRun | null = selectedRunId === "live-draft"
    ? {
        id: "live-draft",
        timestamp: new Date().toISOString(),
        rawText: liveTranscript,
        status: isLiveAnalyzing ? "processing" : "completed",
        analysis: liveDraft || undefined
      }
    : (selectedRun || null);

  return (
    <div className="min-h-screen bg-stone-100/40 text-stone-900 flex flex-col font-sans selection:bg-amber-100">
      
      {/* Toast Alert overlay */}
      {toastMessage && (
        <div id="toast-banner-msg" className="fixed bottom-6 right-6 z-50 bg-stone-900 border border-stone-800 text-stone-100 text-xs font-semibold px-4 py-3 rounded-xl shadow-lg flex items-center gap-2.5 max-w-sm animate-fade-in animate-slide-up">
          <Info className="w-4 h-4 text-amber-500 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Container spacing */}
      <div className="w-full max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-6 flex-1">
        
        {/* Navigation & configurations */}
        <Header 
          token={token} 
          onSetToken={handleSetToken} 
          clientId={clientId} 
          onSetClientId={handleSetClientId} 
        />

        {/* Sync Mode Info Header banner */}
        {!token && (
          <div className="bg-amber-50 border border-amber-200/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-inner">
            <div className="flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-xs font-bold text-stone-800 font-sans">Currently running in Sandbox Preview Mode (Simulated APIs)</p>
                <p className="text-[11px] text-stone-500 leading-normal font-sans">
                  No active Google data is modified. Perfect for quick mock evaluation! Click Google Sync on the right to authorization with real Google Calendar, Tasks, and Drive.
                </p>
              </div>
            </div>
            <button
              onClick={handleGoogleSignIn}
              className="px-4.5 py-2 text-xs font-bold bg-stone-900 hover:bg-stone-800 text-stone-100 hover:text-white rounded-lg border border-stone-950 shadow-sm flex items-center justify-center gap-1.5 transition-all self-start md:self-auto shrink-0 w-full md:w-auto"
            >
              <FolderSync className="w-4 h-4" /> Sign in with Google
            </button>
          </div>
        )}

        {/* Content layout: Top Row (Microphone) */}
        <div className="w-full">
          <AudioRecorder 
            onAnalyze={handleAnalyzeStream} 
            isProcessing={isProcessing} 
            onShowToast={showToast}
            clearSignal={clearSignal}
            onChangeTranscript={setLiveTranscript}
            onChangeSummary={setLiveSummary}
            onListeningChange={setIsMicActive}
          />
        </div>

        {/* Results layout: rendered cleanly underneath the Microphone */}
        <div className="pt-2">
          <ActiveSession 
            run={displayedRun} 
            token={token}
            onExecuteCalendar={handleExecuteCalendar}
            onExecuteTask={handleExecuteTask}
            onExecuteSearch={handleExecuteSearch}
            onExecuteDrive={handleExecuteDrive}
            onUpdateCalendar={handleUpdateCalendar}
            onUpdateTask={handleUpdateTask}
            isLiveAnalyzing={isLiveAnalyzing}
          />
        </div>

        {/* Brain Dump Archive: moved all the way to the bottom of the screen */}
        <div id="brain-dump-archive-section" className="pt-6 border-t border-stone-200/65 space-y-4">
          {runs.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-9">
                <SessionHistory 
                  runs={runs} 
                  selectedRunId={selectedRunId} 
                  onSelectRun={setSelectedRunId} 
                />
              </div>
              <div className="lg:col-span-3">
                {!token && (
                  <button
                    onClick={handleClearSandbox}
                    className="w-full py-3 text-[11px] font-bold text-stone-400 hover:text-stone-650 hover:bg-stone-50 hover:border-stone-300 border border-dashed border-stone-200 rounded-xl transition-all cursor-pointer text-center"
                  >
                    Reset Offline Sandbox databases
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white/40 border border-stone-200/50 rounded-2xl p-5 text-center text-xs text-stone-400 italic">
              No past streaming sessions found. Run a stream of consciousness recording to begin compiling folders.
            </div>
          )}
        </div>

        {/* Clear All Session Data button */}
        <div className="pt-4 flex justify-center">
          <button
            onClick={handleClearAll}
            className="flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-stone-400 hover:text-red-600 bg-transparent hover:bg-red-50 border border-dashed border-stone-200 hover:border-red-300 rounded-xl transition-all cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear All Session Data
          </button>
        </div>

      </div>

      {/* Humble aesthetic footer */}
      <footer className="border-t border-stone-200 bg-stone-50/50 py-4 text-center text-[10px] text-stone-400 uppercase tracking-widest font-mono">
        Stream Consciousness Agent &bull; Engineered on top-tier Google GenAI models &bull; mlibbeyv@gmail.com
      </footer>

    </div>
  );
}
