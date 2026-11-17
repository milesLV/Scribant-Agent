import { useState, useEffect, useMemo } from "react";
import {
  Code2,
  Search,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Layers,
  Terminal,
  Server,
} from "lucide-react";

interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  paths: Record<string, Record<string, EndpointOperation>>;
}

interface EndpointOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: string; default?: any };
  }[];
  requestBody?: { content?: { "application/json"?: { schema?: Record<string, any> } } };
}

const H4 = "text-[11px] font-bold text-stone-700 uppercase tracking-wider font-mono";

// A titled spec table: header labels plus one row of cells per entry.
function SpecTable({ title, head, rows }: { title: string; head: string[]; rows: [string, React.ReactNode[]][] }) {
  return (
    <div className="space-y-2 pt-2">
      <h4 className={H4}>{title}</h4>
      <div className="bg-white border border-stone-200 rounded-xl overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200 text-[10px] text-stone-500 font-mono uppercase">
              {head.map(h => <th key={h} className="p-2.5 font-bold">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-xs">
            {rows.map(([key, cells]) => (
              <tr key={key} className="hover:bg-stone-50/50">
                {cells.map((c, i) => <td key={i} className="p-2.5">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ApiDocsView() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("All");
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/openapi.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.json();
      })
      .then((data: OpenApiSpec) => {
        setSpec(data);
        // Expand the first five paths by default.
        setExpandedEndpoints(Object.fromEntries(Object.entries(data.paths || {}).slice(0, 5)
          .flatMap(([path, methods]) => Object.keys(methods).map(m => [`${m.toUpperCase()}:${path}`, true]))));
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load OpenAPI spec:", err);
        setError(err.message || "Failed to load API spec");
        setLoading(false);
      });
  }, []);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const allEndpoints = useMemo(() =>
    Object.entries(spec?.paths || {}).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        path, operation, method: method.toUpperCase(), tag: operation.tags?.[0] || "General", key: `${method.toUpperCase()}:${path}`,
      }))), [spec]);

  const tags = useMemo(() => ["All", ...new Set(allEndpoints.map(e => e.tag))], [allEndpoints]);

  const filteredEndpoints = useMemo(() => {
    return allEndpoints.filter((item) => {
      const matchesTag = selectedTag === "All" || item.tag === selectedTag;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        item.path.toLowerCase().includes(q) ||
        item.method.toLowerCase().includes(q) ||
        item.operation.summary?.toLowerCase().includes(q) ||
        item.operation.description?.toLowerCase().includes(q);

      return matchesTag && matchesSearch;
    });
  }, [allEndpoints, selectedTag, searchQuery]);

  const groupedEndpoints = useMemo(() => {
    const groups: Record<string, typeof filteredEndpoints> = {};
    for (const e of filteredEndpoints) (groups[e.tag] ||= []).push(e);
    return groups;
  }, [filteredEndpoints]);

  if (loading) {
    return (
      <div className="p-12 text-center text-stone-500 font-sans space-y-3">
        <div className="animate-spin w-6 h-6 border-2 border-stone-400 border-t-amber-600 rounded-full mx-auto" />
        <p className="text-xs font-medium">Loading OpenAPI specification...</p>
      </div>
    );
  }

  if (error || !spec) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-xs font-sans space-y-2">
        <p className="font-bold">Failed to load API specification</p>
        <p>{error || "No specification data returned."}</p>
      </div>
    );
  }

  return (
    <div id="native-api-docs" className="space-y-6 pt-1 font-sans">
      {/* Top Banner & Control Bar */}
      <div className="bg-white border border-stone-200/90 rounded-2xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-600">
                <Code2 className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-extrabold text-stone-900 tracking-tight">
                {spec.info.title} <span className="text-stone-400 font-normal text-xs font-mono ml-1">v{spec.info.version}</span>
              </h2>
            </div>
            <p className="text-xs text-stone-500 leading-normal max-w-3xl">
              {spec.info.description}
            </p>
          </div>

          {/* Quick links to raw spec & standalone page */}
          <div className="flex items-center gap-2 shrink-0">
            {([["/api/openapi.json", Terminal, "Raw JSON Spec"], ["/docs", Server, "Interactive Docs"]] as const).map(([href, Icon, label]) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-600 hover:text-stone-900 bg-stone-100 hover:bg-stone-200/70 rounded-xl border border-stone-200/80 transition-all"
              >
                <Icon className="w-3.5 h-3.5 text-stone-500" />
                <span>{label}</span>
                <ExternalLink className="w-3 h-3 text-stone-400" />
              </a>
            ))}
          </div>
        </div>

        {/* Search & Tag Filter Bar */}
        <div className="pt-3 border-t border-stone-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Tag Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
            {tags.map((t) => (
              <button
                key={t}
                onClick={() => setSelectedTag(t)}
                className={`px-3 py-1 text-xs rounded-lg font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  selectedTag === t
                    ? "bg-stone-900 text-white shadow-2xs font-bold"
                    : "bg-stone-100 hover:bg-stone-200/70 text-stone-600 border border-stone-200/60"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative w-full md:w-72 shrink-0">
            <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search endpoints or parameters..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-stone-50 border border-stone-200 rounded-xl text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-1 focus:ring-amber-500/50 focus:border-amber-500 font-sans"
            />
          </div>
        </div>
      </div>

      {/* Grouped Endpoints */}
      {Object.keys(groupedEndpoints).length === 0 ? (
        <div className="p-8 text-center bg-white border border-stone-200/90 rounded-2xl text-stone-500 text-xs font-sans">
          No endpoints match the query "{searchQuery}".
        </div>
      ) : (
        Object.entries(groupedEndpoints).map(([tagName, endpoints]) => (
          <div key={tagName} className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <Layers className="w-3.5 h-3.5 text-stone-400" />
              <h3 className="text-xs font-bold text-stone-700 uppercase tracking-wider font-mono">
                {tagName}
              </h3>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-200/80 text-stone-600 font-mono">
                {endpoints.length}
              </span>
            </div>

            <div className="space-y-3">
              {endpoints.map((ep) => {
                const isExpanded = !!expandedEndpoints[ep.key];
                const methodBg =
                  ep.method === "POST"
                    ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30"
                    : ep.method === "GET"
                    ? "bg-sky-500/10 text-sky-700 border-sky-500/30"
                    : "bg-amber-500/10 text-amber-700 border-amber-500/30";

                const reqBodySchema = ep.operation.requestBody?.content?.["application/json"]?.schema;
                const reqProps = reqBodySchema?.properties || {};
                const requiredFields = new Set<string>(reqBodySchema?.required || []);

                const sampleCurl = `curl -X ${ep.method} "http://localhost:3000${ep.path}" \\
  -H "Content-Type: application/json"${
    Object.keys(reqProps).length > 0
      ? ` \\
  -d '${JSON.stringify(
    Object.fromEntries(
      Object.entries(reqProps).map(([k, v]: [string, any]) => [
        k,
        v.type === "boolean" ? true : v.type === "number" ? 1 : `sample_${k}`,
      ])
    ),
    null,
    2
  )}'`
      : ""
  }`;

                return (
                  <div
                    key={ep.key}
                    className="bg-white border border-stone-200/90 rounded-2xl overflow-hidden shadow-2xs transition-all hover:border-stone-300"
                  >
                    {/* Header Bar */}
                    <button
                      onClick={() => setExpandedEndpoints(prev => ({ ...prev, [ep.key]: !prev[ep.key] }))}
                      className="w-full text-left p-4 flex items-center justify-between gap-3 hover:bg-stone-50/70 transition-colors cursor-pointer"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <span
                          className={`px-2.5 py-1 text-[11px] font-mono font-extrabold rounded-lg border uppercase tracking-wider ${methodBg}`}
                        >
                          {ep.method}
                        </span>
                        <code className="text-xs font-bold text-stone-800 font-mono">
                          {ep.path}
                        </code>
                        {ep.operation.summary && (
                          <span className="text-xs text-stone-500 font-sans border-l border-stone-200 pl-3">
                            {ep.operation.summary}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-stone-400 shrink-0">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-stone-600" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </div>
                    </button>

                    {/* Expanded Spec Panel */}
                    {isExpanded && (
                      <div className="p-4 pt-0 border-t border-stone-100 bg-stone-50/40 space-y-4 text-xs font-sans">
                        {ep.operation.description && (
                          <p className="text-stone-600 leading-relaxed pt-3">
                            {ep.operation.description}
                          </p>
                        )}

                        {!!ep.operation.parameters?.length && (
                          <SpecTable title="Parameters" head={["Parameter", "In", "Type", "Description"]}
                            rows={ep.operation.parameters.map(param => [param.name, [
                              <span className="font-mono font-bold text-stone-800">
                                {param.name}
                                {param.required && <span className="ml-1 text-[10px] text-red-600 font-sans font-bold">*required</span>}
                              </span>,
                              <span className="font-mono text-stone-500">{param.in}</span>,
                              <span className="font-mono text-amber-700">{param.schema?.type || "string"}</span>,
                              <span className="text-stone-600">{param.description || "—"}</span>,
                            ]])} />
                        )}

                        {Object.keys(reqProps).length > 0 && (
                          <SpecTable title="Request Body (JSON)" head={["Field", "Type", "Required", "Description"]}
                            rows={Object.entries(reqProps).map(([propName, propDef]: [string, any]) => [propName, [
                              <span className="font-mono font-bold text-stone-800">{propName}</span>,
                              <span className="font-mono text-amber-700">{propDef.type || "string"}</span>,
                              requiredFields.has(propName)
                                ? <span className="px-1.5 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800 rounded">Required</span>
                                : <span className="text-stone-400 text-[10px]">Optional</span>,
                              <span className="text-stone-600">{propDef.description || "—"}</span>,
                            ]])} />
                        )}

                        {/* cURL Snippet */}
                        <div className="space-y-1.5 pt-2">
                          <div className="flex items-center justify-between">
                            <h4 className={H4}>cURL Command</h4>
                            <button
                              onClick={() => copyToClipboard(sampleCurl, `curl:${ep.key}`)}
                              className="flex items-center gap-1 text-[11px] font-semibold text-stone-500 hover:text-stone-800 cursor-pointer"
                            >
                              {copiedKey === `curl:${ep.key}` ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-600" />
                                  <span className="text-emerald-600">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>Copy cURL</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="p-3 bg-stone-900 text-stone-200 rounded-xl font-mono text-[11px] overflow-x-auto border border-stone-800 leading-normal">
                            {sampleCurl}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
