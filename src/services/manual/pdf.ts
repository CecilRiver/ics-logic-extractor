/** 仅在浏览器端调用：pdfjs-dist 依赖 DOM/Worker，不参与 SSR。 */

export interface PdfParseOptions {
  /** 页眉裁剪比例（页面高度的百分比），0.08 约等于 RAG 原型的 70pt 上边距。 */
  headerRatio?: number;
  /** 页脚裁剪比例。 */
  footerRatio?: number;
  onProgress?: (page: number, total: number) => void;
}

export interface PdfParseResult {
  pages: string[];
  warnings: string[];
}

const clampRatio = (value: number | undefined, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.3, Math.max(0, value as number));
};

function isTextItem(item: unknown): item is { str: string; hasEOL?: boolean; transform?: number[] } {
  return Boolean(item) && typeof item === 'object' && typeof (item as { str?: unknown }).str === 'string';
}

function joinItem(text: string, next: string): string {
  if (!text) return next;
  const prev = text[text.length - 1] ?? '';
  const first = next[0] ?? '';
  // 中文不需要空格；仅当两侧都是 ASCII 字母数字时补一个空格。
  const needsSpace = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(first);
  return text + (needsSpace ? ' ' : '') + next;
}

export async function extractPdfPages(file: File, options: PdfParseOptions = {}): Promise<PdfParseResult> {
  const headerRatio = clampRatio(options.headerRatio, 0.08);
  const footerRatio = clampRatio(options.footerRatio, 0.09);

  // worker 由 scripts/copy-pdf-worker.mjs 复制到 public/，浏览器按静态文件直接加载。
  // 不要改用 ?url / ?worker：dev 下 Vite 会往 worker 文件里注入 /@vite/client，
  // 而 Worker 环境没有 window，pdfjs 会报 "window is not defined"。
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const pages: string[] = [];
  const warnings: string[] = [];

  try {
    const doc = await loadingTask.promise;
    for (let n = 1; n <= doc.numPages; n += 1) {
      try {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          if (!isTextItem(item)) continue;
          const y = item.transform?.[5];
          if (typeof y === 'number') {
            if (y < viewport.height * footerRatio) continue;
            if (y > viewport.height * (1 - headerRatio)) continue;
          }
          const value = item.str.replace(/ /g, ' ');
          if (!value) continue;
          text = joinItem(text, value);
          if (item.hasEOL) text += '\n';
        }
        pages.push(text.replace(/[ \t]+\n/g, '\n').trim());
        page.cleanup();
      } catch (error) {
        pages.push('');
        warnings.push(`第 ${n} 页解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
      options.onProgress?.(n, doc.numPages);
    }
  } finally {
    await loadingTask.destroy();
  }

  if (!pages.some(Boolean)) warnings.push('PDF 中没有提取到文本，可能是扫描件，需要先做 OCR。');
  return { pages, warnings };
}

/** TXT / Markdown 的轻量分页：按换页符或等长切片，保持页码语义。 */
export function splitPlainText(text: string, pages = 1): string[] {
  const source = text.replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  if (source.includes('\f')) return source.split('\f').map((part) => part.trim());
  const count = Math.max(1, Math.floor(pages));
  if (count === 1) return [source];
  const size = Math.ceil(source.length / count);
  const result: string[] = [];
  for (let i = 0; i < source.length; i += size) result.push(source.slice(i, i + size).trim());
  return result.filter(Boolean);
}
