export type NormalizedTextBox = { x: number; y: number; width: number; height: number };
export type PositionedTextTarget = {
  excerpt: string;
  boundingBox: NormalizedTextBox;
  lineStart: number;
  lineEnd: number;
  occurrences: number;
};

type PositionedLine = PositionedTextTarget['boundingBox'] & { text: string; lineNumber: number };

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function attribute(source: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '';
}

function decodeXml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code.toLowerCase() === 'amp') return '&';
    if (code.toLowerCase() === 'lt') return '<';
    if (code.toLowerCase() === 'gt') return '>';
    if (code.toLowerCase() === 'quot') return '"';
    if (code.toLowerCase() === 'apos') return "'";
    const numeric = code.toLowerCase().startsWith('#x') ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    try { return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity; } catch { return entity; }
  });
}

export function extractPositionedTextLines(svg: string, maxLines = 600) {
  const svgAttributes = svg.match(/<svg\b([^>]*)>/i)?.[1] ?? '';
  const viewBox = attribute(svgAttributes, 'viewBox').split(/[ ,]+/).map(Number);
  const minX = viewBox.length === 4 && Number.isFinite(viewBox[0]) ? viewBox[0]! : 0;
  const minY = viewBox.length === 4 && Number.isFinite(viewBox[1]) ? viewBox[1]! : 0;
  const pageWidth = viewBox.length === 4 && viewBox[2]! > 0 ? viewBox[2]! : Number.parseFloat(attribute(svgAttributes, 'width')) || 612;
  const pageHeight = viewBox.length === 4 && viewBox[3]! > 0 ? viewBox[3]! : Number.parseFloat(attribute(svgAttributes, 'height')) || 792;
  const positioned: string[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text\s*>/gi)) {
    const textAttributes = match[1] ?? '';
    const inner = match[2] ?? '';
    const firstSpanAttributes = inner.match(/<tspan\b([^>]*)>/i)?.[1] ?? '';
    const x = Number.parseFloat(attribute(textAttributes, 'x') || attribute(firstSpanAttributes, 'x'));
    const y = Number.parseFloat(attribute(textAttributes, 'y') || attribute(firstSpanAttributes, 'y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const style = attribute(textAttributes, 'style');
    const fontSize = Number.parseFloat(attribute(textAttributes, 'font-size') || style.match(/font-size\s*:\s*([\d.]+)/i)?.[1] || '') || 10;
    const text = decodeXml(inner.replace(/<[^>]*>/g, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 2000);
    if (!text) continue;
    const normalizedX = clamp((x - minX) / pageWidth);
    const normalizedY = clamp((y - minY - fontSize) / pageHeight);
    const width = Math.min(1 - normalizedX, Math.max(0.008, text.length * fontSize * 0.52 / pageWidth));
    const height = Math.min(1 - normalizedY, Math.max(0.008, fontSize * 1.25 / pageHeight));
    if (width <= 0 || height <= 0) continue;
    positioned.push(`[x=${normalizedX.toFixed(3)}, y=${normalizedY.toFixed(3)}, w=${width.toFixed(3)}, h=${height.toFixed(3)}] ${text}`);
    if (positioned.length >= Math.min(Math.max(Math.floor(maxLines), 1), 1000)) break;
  }
  return positioned;
}

function parsePositionedLine(line: string, lineNumber: number): PositionedLine | null {
  const match = line.match(/^\[\s*x=([\d.]+),\s*y=([\d.]+),\s*w=([\d.]+),\s*h=([\d.]+)\s*\]\s*(.+)$/u);
  if (!match) return null;
  const [, x, y, width, height, text] = match;
  const values = [Number(x), Number(y), Number(width), Number(height)];
  if (!values.every(Number.isFinite)) return null;
  const [boxX, boxY, boxWidth, boxHeight] = values;
  if (boxX! < 0 || boxY! < 0 || boxWidth! <= 0 || boxHeight! <= 0 || boxX! + boxWidth! > 1.001 || boxY! + boxHeight! > 1.001) return null;
  return { x: boxX!, y: boxY!, width: boxWidth!, height: boxHeight!, text: text!.trim(), lineNumber };
}

function normalizeText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function countOccurrences(value: string, query: string) {
  let count = 0;
  let offset = 0;
  while (query && (offset = value.indexOf(query, offset)) >= 0) {
    count += 1;
    offset += query.length;
  }
  return count;
}

export function findPositionedTextTargets(lines: string[], query: string, limit = 8): PositionedTextTarget[] {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length < 2) return [];
  const positioned = lines.map(parsePositionedLine).filter((line): line is PositionedLine => line !== null);
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
  const targets = new Map<string, PositionedTextTarget>();
  for (let start = 0; start < positioned.length && targets.size < boundedLimit; start += 1) {
    const group: PositionedLine[] = [];
    for (let end = start; end < Math.min(positioned.length, start + 4); end += 1) {
      const line = positioned[end]!;
      group.push(line);
      const normalizedLines = group.map((item) => normalizeText(item.text));
      const lineStarts: number[] = [];
      let combinedLength = 0;
      for (const normalizedLine of normalizedLines) {
        lineStarts.push(combinedLength);
        combinedLength += normalizedLine.length + 1;
      }
      const normalizedCombinedText = normalizedLines.join(' ');
      let matchStart = 0;
      while (targets.size < boundedLimit && (matchStart = normalizedCombinedText.indexOf(normalizedQuery, matchStart)) >= 0) {
        const matchEnd = matchStart + normalizedQuery.length;
        let firstLocalIndex = 0;
        for (let index = 1; index < lineStarts.length && lineStarts[index]! <= matchStart; index += 1) firstLocalIndex = index;
        let lastLocalIndex = firstLocalIndex;
        for (let index = firstLocalIndex + 1; index < lineStarts.length && lineStarts[index]! < matchEnd; index += 1) lastLocalIndex = index;
        const matchedLines = group.slice(firstLocalIndex, lastLocalIndex + 1);
        const key = `${matchedLines[0]!.lineNumber}:${matchedLines.at(-1)!.lineNumber}:${matchStart - lineStarts[firstLocalIndex]!}`;
        if (!targets.has(key)) {
          const left = Math.min(...matchedLines.map((item) => item.x));
          const top = Math.min(...matchedLines.map((item) => item.y));
          const right = Math.max(...matchedLines.map((item) => item.x + item.width));
          const bottom = Math.max(...matchedLines.map((item) => item.y + item.height));
          const boundingBox = { x: left, y: top, width: Math.min(1 - left, right - left), height: Math.min(1 - top, bottom - top) };
          const excerpt = matchedLines.map((item) => item.text).join(' ').slice(0, 1000);
          targets.set(key, {
            excerpt,
            boundingBox,
            lineStart: matchedLines[0]!.lineNumber,
            lineEnd: matchedLines.at(-1)!.lineNumber,
            occurrences: countOccurrences(normalizeText(excerpt), normalizedQuery),
          });
        }
        matchStart = matchEnd;
      }
    }
  }
  return [...targets.values()];
}
