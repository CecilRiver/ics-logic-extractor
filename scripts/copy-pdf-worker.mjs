// 把 pdfjs 的 worker 复制到 public/，让浏览器按静态文件直接加载。
// 走 Vite 的 ?url / ?worker 时，dev 会往 worker 文件里注入 /@vite/client，
// 而 Worker 环境没有 window，pdfjs 会报 "window is not defined"。public 文件不经过转换。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
const target = join(root, 'public', 'pdf.worker.min.mjs');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[pdf-worker] copied to ${target}`);
