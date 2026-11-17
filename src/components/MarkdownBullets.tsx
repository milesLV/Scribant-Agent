// Renders the outline the summarizer emits: two levels of bullets, ordered or unordered, with
// **bold** and *italic* inline. Parsing lives in src/utils/outline.ts so it can be self-checked
// without a DOM; this file is only the markup.
import { parseOutline, type Inline, type OutlineItem } from "../utils/outline";

const inlineSpans = (parts: Inline[]) =>
  parts.map((p, i) => {
    if (p.bold) return <strong key={i} className="font-semibold text-stone-800">{p.text}</strong>;
    if (p.italic) return <em key={i} className="italic text-stone-500">{p.text}</em>;
    return <span key={i}>{p.text}</span>;
  });

// A list's marker style comes from its first item: the model picks bullets or numbers per group,
// and a group that starts numbered is a sequence all the way down.
function List({ items, depth }: { items: OutlineItem[]; depth: number }) {
  const Tag = items[0]?.ordered ? "ol" : "ul";
  const marker = items[0]?.ordered ? "list-decimal" : depth === 0 ? "list-disc" : "list-[circle]";
  return (
    <Tag className={`${marker} ${depth === 0 ? "pl-5 space-y-1.5" : "pl-4 mt-1 space-y-1"}`}>
      {items.map((item, idx) => (
        <li key={idx} className="leading-relaxed">
          {inlineSpans(item.parts)}
          {item.children.length > 0 && <List items={item.children} depth={depth + 1} />}
        </li>
      ))}
    </Tag>
  );
}

export default function MarkdownBullets({ text }: { text: string }) {
  const items = parseOutline(text);
  if (items.length === 0) return null;
  return (
    <div className="text-stone-600 font-sans text-xs">
      <List items={items} depth={0} />
    </div>
  );
}
