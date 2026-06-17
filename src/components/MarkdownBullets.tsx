// Renders newline-separated markdown bullets with **bold** spans.
export default function MarkdownBullets({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <ul className="list-disc pl-5 space-y-1.5 text-stone-600 font-sans text-xs">
      {lines.map((line, idx) => {
        const cleaned = line.replace(/^[\s*\-•+]+/, "").trim();
        if (!cleaned) return null;

        const parts = cleaned.split(/(\*\*.*?\*\*)/g);
        return (
          <li key={idx} className="leading-relaxed">
            {parts.map((part, pIdx) => {
              if (part.startsWith("**") && part.endsWith("**")) {
                return (
                  <strong key={pIdx} className="font-semibold text-stone-800">
                    {part.slice(2, -2)}
                  </strong>
                );
              }
              return part.replace(/\*\*/g, "");
            })}
          </li>
        );
      })}
    </ul>
  );
}
