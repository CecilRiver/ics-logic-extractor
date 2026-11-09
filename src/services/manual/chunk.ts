import type { ManualSegment } from '../../domain/manual';

export interface ChunkOptions {
  /** 每段最多包含的页数（按非空页计）。默认 4。 */
  pagesPerSegment?: number;
  /** 每段字符上限。默认 12000，约等于 8k 汉字 token。 */
  maxChars?: number;
}

const DEFAULT_PAGES = 4;
const DEFAULT_MAX_CHARS = 12000;
const MIN_MAX_CHARS = 1000;

/**
 * 把单页的正文再切成若干块。优先在空行/段落处断开，
 * 单段仍超长时在标点附近硬切，避免把一句话从中间截断。
 */
export function splitText(text: string, maxChars = DEFAULT_MAX_CHARS): string[] {
  const limit = Math.max(MIN_MAX_CHARS, Math.floor(maxChars));
  const source = text.trim();
  if (!source) return [];
  if (source.length <= limit) return [source];

  const paragraphs = source.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const pieces: string[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) pieces.push(buffer.trim());
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      flush();
      for (const part of hardSplit(paragraph, limit)) pieces.push(part);
      continue;
    }
    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (next.length > limit) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return pieces;
}

function hardSplit(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('；'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('，'),
    );
    const cut = breakAt > limit * 0.5 ? breakAt + 1 : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * 按页分组。与 RAG 原型不同：不会重复最后一页，空页不会生成空分段，
 * 超长页会继续拆分为多个分段（页码区间保持不变）。
 */
export function buildSegments(pages: string[], options: ChunkOptions = {}): ManualSegment[] {
  const pagesPerSegment = Math.max(1, Math.floor(options.pagesPerSegment ?? DEFAULT_PAGES));
  const maxChars = Math.max(MIN_MAX_CHARS, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));

  interface Group { pageStart: number; pageEnd: number; pageCount: number; parts: string[]; length: number }
  const groups: Group[] = [];
  let current: Group | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.parts.join('\n\n').trim();
    if (text) groups.push({ pageStart: current.pageStart, pageEnd: current.pageEnd, pageCount: current.pageCount, parts: [text], length: text.length });
    current = null;
  };

  pages.forEach((raw, i) => {
    const page = raw.trim();
    if (!page) return;
    const pageNumber = i + 1;
    if (current && (current.pageCount >= pagesPerSegment || current.length + page.length > maxChars)) flush();
    if (!current) current = { pageStart: pageNumber, pageEnd: pageNumber, pageCount: 0, parts: [], length: 0 };
    current.pageEnd = pageNumber;
    current.pageCount += 1;
    current.parts.push(page);
    current.length += page.length;
  });
  flush();

  const segments: ManualSegment[] = [];
  for (const group of groups) {
    const pieces = group.parts[0].length > maxChars ? splitText(group.parts[0], maxChars) : [group.parts[0]];
    for (const piece of pieces) {
      if (!piece) continue;
      segments.push({
        index: segments.length + 1,
        pageStart: group.pageStart,
        pageEnd: group.pageEnd,
        text: piece,
        chars: piece.length,
      });
    }
  }
  return segments;
}
