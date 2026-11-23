import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ManualRunSummary } from '../src/domain/manual.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dataRoot = resolve(repoRoot, 'data', 'manual');

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 20_000;
const RUN_NAME_RE = /^[0-9A-Za-z._-]+$/;

type JsonObject = Record<string, unknown>;

interface RunMeta extends ManualRunSummary {
  schemaVersion: 1;
  fileMeta: { name: string; size: number; kind: string; pageCount: number };
  options: { pagesPerSegment: number; maxChars: number; headerPct: number; footerPct: number };
  segments: Array<{ index: number; pageStart: number; pageEnd: number; chars: number; status: string }>;
}

interface RunState {
  pages: string[];
  runs: unknown[];
}

interface ParsedRun {
  meta: Omit<RunMeta, 'name'>;
  state: RunState;
}

class BodyTooLargeError extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, code: string, error: string): void {
  send(res, status, { error, code });
}

async function readBody(req: IncomingMessage): Promise<JsonObject> {
  return await new Promise<JsonObject>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        const value = JSON.parse(raw);
        resolvePromise(value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('client_aborted')));
  });
}

function runDirFor(name: string): string | null {
  if (!RUN_NAME_RE.test(name) || name.startsWith('.')) return null;
  const dir = resolve(dataRoot, name);
  return dir.startsWith(`${dataRoot}\\`) || dir.startsWith(`${dataRoot}/`) ? dir : null;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sanitizeSource(source: string): string {
  const base = source
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 48);
  return base || 'manual';
}

async function uniqueRunName(source: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const prefix = `${stamp()}_${sanitizeSource(source)}`;
  let name = prefix;
  let index = 1;
  while (await stat(join(dataRoot, name)).then(() => true).catch(() => false)) {
    name = `${prefix}_${index}`;
    index += 1;
  }
  return name;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rm(path, { force: true });
  await rename(temp, path);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function numberField(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRun(body: JsonObject): ParsedRun | string {
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (!source || source.length > 512) return '来源文件名不合法';

  const model = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : '';
  const fileMetaRaw = asObject(body.fileMeta);
  const optionsRaw = asObject(body.options);
  if (!fileMetaRaw || !optionsRaw) return '缺少 fileMeta 或 options';

  const pages = body.pages;
  const runs = body.runs;
  const segments = body.segments;
  if (!Array.isArray(pages) || pages.some((page) => typeof page !== 'string') || pages.length > MAX_ITEMS) {
    return 'pages 必须是字符串数组';
  }
  if (!Array.isArray(runs) || runs.length > MAX_ITEMS || runs.some((run) => !asObject(run))) {
    return 'runs 必须是对象数组';
  }
  if (!Array.isArray(segments) || segments.length > MAX_ITEMS) {
    return 'segments 必须是数组';
  }

  const segmentList = segments.map((item, index) => {
    const segment = asObject(item) ?? {};
    return {
      index: numberField(segment.index, index + 1),
      pageStart: numberField(segment.pageStart, 1),
      pageEnd: numberField(segment.pageEnd, 1),
      chars: numberField(segment.chars, 0),
      status: typeof segment.status === 'string' ? segment.status : 'done',
    };
  });

  const countRows = (key: string) => runs.reduce((total, run) => {
    const value = (run as JsonObject)[key];
    return total + (Array.isArray(value) ? value.length : 0);
  }, 0);

  const fileMeta = {
    name: typeof fileMetaRaw.name === 'string' ? fileMetaRaw.name.slice(0, 512) : source,
    size: Math.max(0, numberField(fileMetaRaw.size, 0)),
    kind: fileMetaRaw.kind === 'text' ? 'text' : 'pdf',
    pageCount: Math.max(0, Math.round(numberField(fileMetaRaw.pageCount, pages.length))),
  };

  return {
    meta: {
      schemaVersion: 1,
      source,
      createdAt: new Date().toISOString(),
      model,
      fileMeta,
      options: {
        pagesPerSegment: Math.max(1, Math.round(numberField(optionsRaw.pagesPerSegment, 4))),
        maxChars: Math.max(1000, Math.round(numberField(optionsRaw.maxChars, 12000))),
        headerPct: Math.max(0, numberField(optionsRaw.headerPct, 8)),
        footerPct: Math.max(0, numberField(optionsRaw.footerPct, 9)),
      },
      segmentCount: segmentList.length,
      pageCount: fileMeta.pageCount,
      deviceCount: countRows('devices'),
      topologyCount: countRows('topology'),
      logicCount: countRows('logic'),
      segments: segmentList,
    },
    state: { pages: pages as string[], runs },
  };
}

async function readMeta(dir: string): Promise<RunMeta | null> {
  try {
    const value = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    return value && typeof value === 'object' ? value as RunMeta : null;
  } catch {
    return null;
  }
}

async function listRuns(): Promise<ManualRunSummary[]> {
  let entries;
  try {
    entries = await readdir(dataRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: ManualRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_NAME_RE.test(entry.name) || entry.name.startsWith('.')) continue;
    const meta = await readMeta(join(dataRoot, entry.name));
    if (!meta) continue;
    runs.push({
      name: entry.name,
      source: meta.source,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      model: meta.model,
      pageCount: meta.fileMeta?.pageCount ?? 0,
      segmentCount: meta.segmentCount ?? 0,
      deviceCount: meta.deviceCount ?? 0,
      topologyCount: meta.topologyCount ?? 0,
      logicCount: meta.logicCount ?? 0,
    });
  }

  runs.sort((a, b) => (b.updatedAt || b.createdAt || b.name).localeCompare(a.updatedAt || a.createdAt || a.name));
  return runs;
}

async function loadRun(name: string): Promise<{ name: string; meta: RunMeta; pages: string[]; runs: unknown[] } | null> {
  const dir = runDirFor(name);
  if (!dir) return null;
  const meta = await readMeta(dir);
  if (!meta) return null;
  try {
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as RunState;
    return {
      name,
      meta,
      pages: Array.isArray(state.pages) ? state.pages : [],
      runs: Array.isArray(state.runs) ? state.runs : [],
    };
  } catch {
    return null;
  }
}

async function createRun(res: ServerResponse, body: JsonObject): Promise<void> {
  const name = await uniqueRunName(typeof body.source === 'string' ? body.source : 'manual');
  const parsed = parseRun(body);
  if (typeof parsed === 'string') {
    fail(res, 400, 'invalid_run', parsed);
    return;
  }

  const temp = await mkdtemp(join(dataRoot, '.tmp-'));
  try {
    const meta: RunMeta = { ...parsed.meta, name };
    await writeFile(join(temp, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    await writeFile(join(temp, 'state.json'), JSON.stringify(parsed.state), 'utf8');
    await rename(temp, join(dataRoot, name));
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    fail(res, 500, 'save_failed', `历史保存失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  send(res, 200, { name });
}

async function updateRun(res: ServerResponse, name: string, body: JsonObject): Promise<void> {
  const dir = runDirFor(name);
  if (!dir) {
    fail(res, 404, 'not_found', '运行记录不存在');
    return;
  }
  const existing = await readMeta(dir);
  if (!existing) {
    fail(res, 404, 'not_found', '运行记录不存在');
    return;
  }

  const parsed = parseRun(body);
  if (typeof parsed === 'string') {
    fail(res, 400, 'invalid_run', parsed);
    return;
  }

  const meta: RunMeta = {
    ...parsed.meta,
    name,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeJsonAtomic(join(dir, 'state.json'), parsed.state);
    await writeJsonAtomic(join(dir, 'meta.json'), meta);
  } catch (error) {
    fail(res, 500, 'save_failed', `历史更新失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  send(res, 200, { name, updatedAt: meta.updatedAt });
}

async function deleteRun(res: ServerResponse, name: string): Promise<void> {
  const dir = runDirFor(name);
  if (!dir || !(await readMeta(dir))) {
    fail(res, 404, 'not_found', '运行记录不存在');
    return;
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    send(res, 200, { name, deleted: true });
  } catch (error) {
    fail(res, 500, 'delete_failed', `删除运行记录失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function manualRunsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  _next: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = url.pathname;
  if (pathname.startsWith('/api/manual/runs')) {
    pathname = pathname.slice('/api/manual/runs'.length) || '/';
  }

  try {
    if (pathname === '/' && req.method === 'GET') {
      send(res, 200, { runs: await listRuns() });
      return;
    }

    if (pathname === '/' && req.method === 'POST') {
      let body: JsonObject;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          fail(res, 413, 'body_too_large', '请求体超过 64 MB，无法保存历史');
          return;
        }
        fail(res, 400, 'invalid_json', '请求体不是有效的 JSON');
        return;
      }
      await createRun(res, body);
      return;
    }

    const match = pathname.match(/^\/([0-9A-Za-z._-]+)$/);
    if (match && req.method === 'GET') {
      const detail = await loadRun(match[1]);
      if (!detail) {
        fail(res, 404, 'not_found', '运行记录不存在');
        return;
      }
      send(res, 200, detail);
      return;
    }

    if (match && req.method === 'PUT') {
      let body: JsonObject;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          fail(res, 413, 'body_too_large', '请求体超过 64 MB，无法保存历史');
          return;
        }
        fail(res, 400, 'invalid_json', '请求体不是有效的 JSON');
        return;
      }
      await updateRun(res, match[1], body);
      return;
    }

    if (match && req.method === 'DELETE') {
      await deleteRun(res, match[1]);
      return;
    }

    fail(res, 404, 'not_found', '接口不存在');
  } catch (error) {
    console.error('[manual-runs]', error);
    fail(res, 500, 'internal_error', `历史服务内部错误：${error instanceof Error ? error.message : String(error)}`);
  }
}
