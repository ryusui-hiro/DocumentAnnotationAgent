import { DOMParser, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom';
import type { NormalizedTextBox, TextAnchor } from '../src/types';

export type PositionedTextBlock = {
  text: string;
  boundingBox: NormalizedTextBox;
  characterBoxes?: Array<NormalizedTextBox | undefined>;
  lineNumber: number;
};
export type PositionedTextTarget = {
  excerpt: string;
  boundingBox: NormalizedTextBox;
  fragments: NormalizedTextBox[];
  textAnchor: TextAnchor;
  lineStart: number;
  lineEnd: number;
  occurrences: number;
};

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
type NormalizedLine = { text: string; boxes: Array<NormalizedTextBox | undefined>; sourceStarts: number[]; sourceEnds: number[] };
type Glyph = { text: string; x: number; y: number; width: number; height: number; matrix: Matrix };

const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function attr(element: XmlElement, name: string) {
  return element.getAttribute(name) ?? '';
}

function numbers(value: string) {
  return (value.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number).filter(Number.isFinite);
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function parseTransform(value: string): Matrix | null {
  if (!value.trim()) return identity;
  const expression = /([a-z]+)\s*\(([^)]*)\)/gi;
  const operations = [...value.matchAll(expression)];
  if (!operations.length || value.replace(expression, '').replace(/[\s,]+/g, '')) return null;
  let matrix = identity;
  for (const operation of operations) {
    const name = operation[1]!.toLowerCase();
    const args = numbers(operation[2]!);
    let next: Matrix;
    if (name === 'matrix' && args.length === 6) {
      next = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! };
    } else if (name === 'translate' && (args.length === 1 || args.length === 2)) {
      next = { ...identity, e: args[0]!, f: args[1] ?? 0 };
    } else if (name === 'scale' && (args.length === 1 || args.length === 2)) {
      next = { a: args[0]!, b: 0, c: 0, d: args[1] ?? args[0]!, e: 0, f: 0 };
    } else if (name === 'rotate' && (args.length === 1 || args.length === 3)) {
      const radians = (args[0]! * Math.PI) / 180;
      const rotation = { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 };
      if (args.length === 3) {
        const x = args[1]!;
        const y = args[2]!;
        next = multiply(multiply({ ...identity, e: x, f: y }, rotation), { ...identity, e: -x, f: -y });
      } else next = rotation;
    } else if (name === 'skewx' && args.length === 1) {
      next = { a: 1, b: 0, c: Math.tan((args[0]! * Math.PI) / 180), d: 1, e: 0, f: 0 };
    } else if (name === 'skewy' && args.length === 1) {
      next = { a: 1, b: Math.tan((args[0]! * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
    } else return null;
    matrix = multiply(matrix, next);
  }
  return Object.values(matrix).every(Number.isFinite) ? matrix : null;
}

function matrixForNode(element: XmlElement): Matrix | null {
  const chain: XmlElement[] = [];
  for (let node: XmlNode | null = element; node && node.nodeType === 1; node = node.parentNode) chain.unshift(node as XmlElement);
  let matrix = identity;
  for (const current of chain) {
    const transform = attr(current, 'transform') || attr(current, 'style').match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i)?.[1] || '';
    const local = parseTransform(transform);
    if (!local) return null;
    matrix = multiply(matrix, local);
  }
  return matrix;
}

function fontSizeFor(element: XmlElement, fallback = 10) {
  for (let node: XmlNode | null = element; node && node.nodeType === 1; node = node.parentNode) {
    const current = node as XmlElement;
    const value = attr(current, 'font-size') || attr(current, 'style').match(/font-size\s*:\s*([\d.]+)/i)?.[1];
    const parsed = Number.parseFloat(value ?? '');
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function glyphAdvance(value: string, fontSize: number) {
  const factor = Array.from(value).reduce((sum, character) => {
    if (/\s/u.test(character)) return sum + 0.28;
    if (/[ilI.,:;'!|]/u.test(character)) return sum + 0.28;
    if (/[mwMW@%&]/u.test(character)) return sum + 0.78;
    if (/[A-Z0-9]/u.test(character)) return sum + 0.60;
    if (/[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)) return sum + 1;
    return sum + 0.52;
  }, 0);
  return Math.max(fontSize * 0.12, factor * fontSize);
}

function transformBox(matrix: Matrix, x: number, y: number, width: number, height: number, page: { x: number; y: number; width: number; height: number }): NormalizedTextBox | null {
  const points = [
    [x, y], [x + width, y], [x + width, y + height], [x, y + height],
  ].map(([pointX, pointY]) => ({ x: matrix.a * pointX! + matrix.c * pointY! + matrix.e, y: matrix.b * pointX! + matrix.d * pointY! + matrix.f }));
  const left = Math.max(page.x, Math.min(...points.map((point) => point.x)));
  const top = Math.max(page.y, Math.min(...points.map((point) => point.y)));
  const right = Math.min(page.x + page.width, Math.max(...points.map((point) => point.x)));
  const bottom = Math.min(page.y + page.height, Math.max(...points.map((point) => point.y)));
  if (right <= left || bottom <= top) return null;
  return {
    x: clamp((left - page.x) / page.width),
    y: clamp((top - page.y) / page.height),
    width: clamp((right - left) / page.width),
    height: clamp((bottom - top) / page.height),
  };
}

function unionBoxes(boxes: NormalizedTextBox[]): NormalizedTextBox | null {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeVisibleText(value: string, boxes: Array<NormalizedTextBox | undefined>) {
  const output: string[] = [];
  const characterBoxes: Array<NormalizedTextBox | undefined> = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  for (const [sourceIndex, sourceCharacter] of Array.from(value).entries()) {
    const normalized = Array.from(sourceCharacter.normalize('NFKC'));
    for (const character of normalized) {
      if (/\s/u.test(character)) {
        if (!output.length || output.at(-1) === ' ') {
          if (output.length && boxes[sourceIndex]) {
            const merged = unionBoxes([characterBoxes.at(-1), boxes[sourceIndex]].filter((box): box is NormalizedTextBox => Boolean(box)));
            if (merged) characterBoxes[characterBoxes.length - 1] = merged;
            sourceEnds[sourceEnds.length - 1] = sourceIndex + 1;
          }
          continue;
        }
        output.push(' ');
        characterBoxes.push(boxes[sourceIndex]);
        sourceStarts.push(sourceIndex);
        sourceEnds.push(sourceIndex + 1);
        continue;
      }
      output.push(character);
      characterBoxes.push(boxes[sourceIndex]);
      sourceStarts.push(sourceIndex);
      sourceEnds.push(sourceIndex + 1);
    }
  }
  if (output.at(-1) === ' ') {
    output.pop(); characterBoxes.pop(); sourceStarts.pop(); sourceEnds.pop();
  }
  return { text: output.join(''), boxes: characterBoxes, sourceStarts, sourceEnds };
}

function normalizeSearchText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function normalizeSvgTextElement(element: XmlElement, page: { x: number; y: number; width: number; height: number }, lineNumber: number): PositionedTextBlock | null {
  const matrix = matrixForNode(element);
  if (!matrix) return null;
  const textNodes = Array.from(element.getElementsByTagName('tspan'));
  const leafSpans = textNodes.filter((span) => span.getElementsByTagName('tspan').length === 0 && Boolean(span.textContent));
  const textXValue = Number.parseFloat(attr(element, 'x'));
  const textYValue = Number.parseFloat(attr(element, 'y'));
  const positionedSpan = leafSpans.some((span) => attr(span, 'x') !== '' || attr(span, 'y') !== '');
  const hasTransform = Boolean(attr(element, 'transform').trim());
  if (!Number.isFinite(textXValue) && !Number.isFinite(textYValue) && !positionedSpan && !hasTransform) return null;
  const textX = Number.isFinite(textXValue) ? textXValue : 0;
  const textY = Number.isFinite(textYValue) ? textYValue : 0;
  const textAnchor = attr(element, 'text-anchor') || 'start';
  const ariaLabel = attr(element, 'aria-label').replace(/\s+/gu, ' ').trim();
  const spanText = leafSpans.map((span) => span.textContent ?? '').join('');
  const directText = element.textContent ?? '';
  const visibleText = ariaLabel || directText.replace(/\s+/gu, ' ').trim();
  if (!visibleText) return null;

  const fontSize = fontSizeFor(element, 10);
  const glyphs: Glyph[] = [];
  if (leafSpans.length && normalizeSearchText(spanText) === normalizeSearchText(visibleText)) {
    let cursorX = textX;
    let cursorY = textY;
    const runs = leafSpans.map((span) => {
      const chars = Array.from(span.textContent ?? '');
      const xValues = numbers(attr(span, 'x'));
      const yValues = numbers(attr(span, 'y'));
      const runFontSize = fontSizeFor(span, fontSize);
      const runWidth = Number.parseFloat(attr(span, 'textLength')) || glyphAdvance(chars.join(''), runFontSize);
      const startX = xValues[0] ?? cursorX;
      const startY = yValues[0] ?? cursorY;
      const weights = chars.map((character) => glyphAdvance(character, runFontSize));
      const totalWeight = Math.max(0.001, weights.reduce((sum, value) => sum + value, 0));
      const positions: number[] = [];
      let offset = 0;
      for (let index = 0; index < chars.length; index += 1) {
        positions.push(xValues[index] ?? startX + offset);
        offset += runWidth * (weights[index] ?? 0) / totalWeight;
      }
      cursorX = startX + runWidth;
      cursorY = startY;
      return { chars, positions, yValues, startY, weights, runWidth, runFontSize, span, matrix: matrixForNode(span) ?? matrix };
    });
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const run = runs[runIndex]!;
      for (let charIndex = 0; charIndex < run.chars.length; charIndex += 1) {
        const x = run.positions[charIndex]!;
        const y = run.yValues[charIndex] ?? run.startY;
        const next = runIndex + 1 < runs.length ? runs[runIndex + 1] : undefined;
        const nextX = next?.positions[0];
        const nextY = next?.startY ?? y;
        const inferredAdvance = nextX !== undefined && Math.abs(nextY - y) < run.runFontSize * 0.35 && nextX > x
          ? Math.min(nextX - x, run.runFontSize * 2)
          : undefined;
        const advance = charIndex + 1 < run.chars.length
          ? run.runWidth * (run.weights[charIndex] ?? 0) / Math.max(0.001, run.weights.reduce((sum, value) => sum + value, 0))
          : inferredAdvance ?? run.runFontSize * (run.weights[charIndex] ?? 0.5) / Math.max(0.001, run.weights.reduce((sum, value) => sum + value, 0));
        glyphs.push({ text: run.chars[charIndex]!, x, y, width: Math.max(run.runFontSize * 0.08, advance), height: run.runFontSize * 1.25, matrix: run.matrix });
      }
    }
  } else {
    const chars = Array.from(visibleText);
    const textLength = Number.parseFloat(attr(element, 'textLength'));
    const totalWidth = Number.isFinite(textLength) && textLength > 0 ? textLength : glyphAdvance(visibleText, fontSize);
    const weights = chars.map((character) => glyphAdvance(character, fontSize));
    const totalWeight = Math.max(0.001, weights.reduce((sum, value) => sum + value, 0));
    let x = textX;
    if (textAnchor === 'middle') x -= totalWidth / 2;
    else if (textAnchor === 'end') x -= totalWidth;
    for (let index = 0; index < chars.length; index += 1) {
      const width = totalWidth * (weights[index] ?? 0) / totalWeight;
      glyphs.push({ text: chars[index]!, x, y: textY, width: Math.max(fontSize * 0.08, width), height: fontSize * 1.25, matrix });
      x += width;
    }
  }

  const rawGlyphBoxes = glyphs.map((glyph) => transformBox(glyph.matrix, glyph.x, glyph.y - glyph.height / 1.25, glyph.width, glyph.height, page));
  const validGlyphBoxes = rawGlyphBoxes.filter((box): box is NormalizedTextBox => box !== null);
  const lineBounds = unionBoxes(validGlyphBoxes);
  if (!lineBounds) return null;
  const glyphText = glyphs.map((glyph) => glyph.text).join('');
  const sourceText = ariaLabel && normalizeSearchText(ariaLabel) === normalizeSearchText(glyphText) ? ariaLabel : glyphText || visibleText;
  let characterBoxes: Array<NormalizedTextBox | undefined> | undefined = glyphText && glyphText === sourceText ? rawGlyphBoxes.map((box) => box ?? undefined) : undefined;
  if (!characterBoxes) {
    const chars = Array.from(sourceText);
    characterBoxes = chars.map((_, index) => {
      const left = lineBounds.x + lineBounds.width * index / Math.max(chars.length, 1);
      const right = lineBounds.x + lineBounds.width * (index + 1) / Math.max(chars.length, 1);
      return { x: left, y: lineBounds.y, width: Math.max(0.001, right - left), height: lineBounds.height };
    });
  }
  const normalized = normalizeVisibleText(sourceText, characterBoxes);
  if (!normalized.text) return null;
  return { text: normalized.text, boundingBox: lineBounds, characterBoxes: normalized.boxes, lineNumber };
}

export function extractPositionedTextBlocks(svg: string, maxLines = 600): PositionedTextBlock[] {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.getElementsByTagName('svg').item(0) as XmlElement | null;
  if (!root) return [];
  const viewBox = numbers(attr(root, 'viewBox'));
  const page = {
    x: viewBox.length === 4 ? viewBox[0]! : 0,
    y: viewBox.length === 4 ? viewBox[1]! : 0,
    width: viewBox.length === 4 && viewBox[2]! > 0 ? viewBox[2]! : Number.parseFloat(attr(root, 'width')) || 612,
    height: viewBox.length === 4 && viewBox[3]! > 0 ? viewBox[3]! : Number.parseFloat(attr(root, 'height')) || 792,
  };
  const output: PositionedTextBlock[] = [];
  const elements = document.getElementsByTagName('text');
  const boundedMax = Math.min(Math.max(Math.floor(maxLines), 1), 1000);
  for (let index = 0; index < elements.length && output.length < boundedMax; index += 1) {
    const element = elements.item(index) as XmlElement | null;
    if (!element) continue;
    const block = normalizeSvgTextElement(element, page, output.length);
    if (block) output.push(block);
  }
  return output;
}

export function extractPositionedTextLines(svg: string, maxLines = 600) {
  return extractPositionedTextBlocks(svg, maxLines).map((line) => `[x=${line.boundingBox.x.toFixed(3)}, y=${line.boundingBox.y.toFixed(3)}, w=${line.boundingBox.width.toFixed(3)}, h=${line.boundingBox.height.toFixed(3)}] ${line.text}`);
}

export function parsePositionedTextLines(lines: string[]): PositionedTextBlock[] {
  return lines.flatMap((line, lineNumber) => {
    if (!line.startsWith('[x=')) return [];
    const closeIndex = line.indexOf('] ');
    if (closeIndex < 0 || closeIndex > 128) return [];
    const fields = line.slice(1, closeIndex).split(',');
    const names = ['x', 'y', 'w', 'h'];
    if (fields.length !== names.length) return [];
    const values = fields.map((field, index) => {
      const equalsIndex = field.indexOf('=');
      if (equalsIndex < 0 || field.slice(0, equalsIndex).trim() !== names[index]) return Number.NaN;
      const rawValue = field.slice(equalsIndex + 1).trim();
      if (!rawValue || rawValue.length > 20) return Number.NaN;
      return Number(rawValue);
    });
    if (!values.every(Number.isFinite)) return [];
    const [x, y, width, height] = values;
    if (x! < 0 || y! < 0 || width! <= 0 || height! <= 0 || x! + width! > 1.001 || y! + height! > 1.001) return [];
    const text = line.slice(closeIndex + 2).trim();
    return text ? [{ text, boundingBox: { x: x!, y: y!, width: width!, height: height! }, lineNumber }] : [];
  });
}

function normalizeForSearch(line: PositionedTextBlock): NormalizedLine {
  const sourceCharacters = Array.from(line.text);
  const text: string[] = [];
  const boxes: Array<NormalizedTextBox | undefined> = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  for (const [sourceIndex, sourceCharacter] of sourceCharacters.entries()) {
    for (const character of Array.from(sourceCharacter.normalize('NFKC').toLocaleLowerCase())) {
      if (/\s/u.test(character)) {
        if (!text.length || text.at(-1) === ' ') {
          if (text.length && line.characterBoxes?.[sourceIndex]) {
            const merged = unionBoxes([boxes.at(-1), line.characterBoxes[sourceIndex]].filter((box): box is NormalizedTextBox => Boolean(box)));
            if (merged) boxes[boxes.length - 1] = merged;
            sourceEnds[sourceEnds.length - 1] = sourceIndex + 1;
          }
          continue;
        }
        text.push(' ');
        boxes.push(line.characterBoxes?.[sourceIndex]);
        sourceStarts.push(sourceIndex);
        sourceEnds.push(sourceIndex + 1);
      } else {
        text.push(character);
        boxes.push(line.characterBoxes?.[sourceIndex]);
        sourceStarts.push(sourceIndex);
        sourceEnds.push(sourceIndex + 1);
      }
    }
  }
  if (text.at(-1) === ' ') { text.pop(); boxes.pop(); sourceStarts.pop(); sourceEnds.pop(); }
  return { text: text.join(''), boxes, sourceStarts, sourceEnds };
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

function sliceCodePoints(value: string, start: number, end: number) {
  return Array.from(value).slice(start, end).join('');
}

function boxForMatchedCharacters(line: PositionedTextBlock, normalized: NormalizedLine, start: number, end: number): NormalizedTextBox | null {
  const actualBoxes = normalized.boxes.slice(start, end).filter((box): box is NormalizedTextBox => Boolean(box));
  if (actualBoxes.length) return unionBoxes(actualBoxes);
  const sourceStart = normalized.sourceStarts[start] ?? 0;
  const sourceEnd = (normalized.sourceEnds[end - 1] ?? sourceStart + 1);
  const length = Math.max(1, Array.from(line.text).length);
  const x = line.boundingBox.x + line.boundingBox.width * sourceStart / length;
  const right = line.boundingBox.x + line.boundingBox.width * sourceEnd / length;
  return { x, y: line.boundingBox.y, width: Math.max(0.001, right - x), height: line.boundingBox.height };
}

export function findPositionedTextTargets(lines: Array<string | PositionedTextBlock>, query: string, limit = 8): PositionedTextTarget[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < 2) return [];
  const positioned = lines.flatMap((line, index) => typeof line === 'string'
    ? parsePositionedTextLines([line]).map((parsed) => ({ ...parsed, lineNumber: index }))
    : [line]);
  const normalizedLines = positioned.map(normalizeForSearch);
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
  const pageOffsets: number[] = [];
  let fullText = '';
  for (const line of normalizedLines) {
    pageOffsets.push(fullText.length);
    fullText += `${line.text} `;
  }
  fullText = fullText.trimEnd();
  const targets = new Map<number, PositionedTextTarget>();

  for (let start = 0; start < normalizedLines.length && targets.size < boundedLimit; start += 1) {
    const group = normalizedLines.slice(start, Math.min(normalizedLines.length, start + 4));
    const groupOffsets: number[] = [];
    let groupText = '';
    for (const line of group) {
      groupOffsets.push(groupText.length);
      groupText += `${line.text} `;
    }
    groupText = groupText.trimEnd();
    let matchStart = 0;
    while (targets.size < boundedLimit && (matchStart = groupText.indexOf(normalizedQuery, matchStart)) >= 0) {
      const matchEnd = matchStart + normalizedQuery.length;
      const fragments: NormalizedTextBox[] = [];
      const excerpts: string[] = [];
      let firstMatchedLine = -1;
      let lastMatchedLine = -1;
      for (let index = 0; index < group.length; index += 1) {
        const line = group[index]!;
        const lineStart = groupOffsets[index]!;
        const lineEnd = lineStart + line.text.length;
        const localStart = Math.max(matchStart, lineStart) - lineStart;
        const localEnd = Math.min(matchEnd, lineEnd) - lineStart;
        if (localStart >= localEnd) continue;
        const fragment = boxForMatchedCharacters(positioned[start + index]!, line, localStart, localEnd);
        if (fragment) fragments.push(fragment);
        const sourceStart = line.sourceStarts[localStart] ?? 0;
        const sourceEnd = line.sourceEnds[localEnd - 1] ?? sourceStart + 1;
        excerpts.push(sliceCodePoints(positioned[start + index]!.text, sourceStart, sourceEnd));
        if (firstMatchedLine < 0) firstMatchedLine = start + index;
        lastMatchedLine = start + index;
      }
      const boundingBox = unionBoxes(fragments);
      if (boundingBox && firstMatchedLine >= 0 && lastMatchedLine >= firstMatchedLine) {
        const globalStart = pageOffsets[start]! + matchStart;
        const globalEnd = pageOffsets[start]! + matchEnd;
        const exact = excerpts.join(' ').replace(/\s+/gu, ' ').trim() || query.trim();
        if (!targets.has(globalStart)) {
          targets.set(globalStart, {
            excerpt: exact,
            boundingBox,
            fragments,
            textAnchor: {
              quote: {
                exact,
                prefix: fullText.slice(Math.max(0, globalStart - 40), globalStart),
                suffix: fullText.slice(globalEnd, Math.min(fullText.length, globalEnd + 40)),
              },
              position: { start: globalStart, end: globalEnd, unit: 'normalized-page-text' },
            },
            lineStart: positioned[firstMatchedLine]!.lineNumber,
            lineEnd: positioned[lastMatchedLine]!.lineNumber,
            occurrences: countOccurrences(fullText, normalizedQuery),
          });
        }
      }
      matchStart = matchEnd;
    }
  }
  return [...targets.values()];
}
