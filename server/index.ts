import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.ts';
import { manualExtractMiddleware } from './manual-extract.ts';

loadEnv();

const distRoot = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const port = Number(process.env.PORT) || 4174;
const host = process.env.HOST || 'localhost';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function serveFile(path: string, res: import('node:http').ServerResponse): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const body = await readFile(path);
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const immutable = path.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.byteLength,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/manual/extract') {
    await manualExtractMiddleware(req, res, () => {
      if (!res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Not found', code: 'not_found' }));
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(distRoot, `.${requested}`);

  if (isInside(distRoot, file) && (await serveFile(file, res))) return;

  // SPA 回退：前端路由（/manual、/traffic）都交给 index.html。
  if (await serveFile(resolve(distRoot, 'index.html'), res)) return;

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('前端构建产物不存在，请先运行 pnpm build。');
});

server.listen(port, host, () => {
  console.log(`[manual-traffic-tools] http://${host}:${port}/`);
});
