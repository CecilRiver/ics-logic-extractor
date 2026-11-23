import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  TrafficCollection,
  TrafficFrame,
  TrafficPoint,
  TrafficRunDetail,
  TrafficRunSummary,
  TrafficStats,
} from '../src/domain/traffic.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pythonDir = resolve(repoRoot, 'python');
const runnerPath = resolve(pythonDir, 'plc_runner.py');
const dataRoot = resolve(repoRoot, 'data', 'traffic');
const incomingRoot = resolve(dataRoot, '.incoming');

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const JOB_TIMEOUT_MS = 180_000;
const VARIABLES_TIMEOUT_MS = 60_000;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

export interface TrafficUnit {
  index: number;
  name: string;
  kind: string;
  chars: number;
  status: string;
  declared: boolean;
  streamOffset: string;
  text: string;
}

export interface TrafficResult {
  plc: string;
  port: number;
  session: string;
  imageBytes: number;
  records: number;
  sha256: string;
  declarations: boolean;
  stu: string | null;
  runDir: string;
  units: TrafficUnit[];
  parsed?: boolean;
  traffic?: TrafficCollection | null;
}

export interface TrafficVariable {
  unit: string;
  name: string;
  type: string;
  category: string;
  range: string;
  basis: string;
}

interface TrafficJob {
  id: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  percent: number;
  message: string;
  error: string;
  warnings: string[];
  result?: TrafficResult;
  variables?: TrafficVariable[];
  variablesError?: string;
  variablesRunning?: boolean;
  createdAt: number;
  updatedAt: number;
  child?: ChildProcess;
  incomingStu?: string;
}

const jobs = new Map<string, TrafficJob>();

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.updatedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
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
        resolvePromise(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('client_aborted')));
  });
}

function publicJob(job: TrafficJob): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    message: job.message,
    error: job.error,
    warnings: job.warnings,
    result: job.result,
    variables: job.variables,
    variablesError: job.variablesError,
    variablesRunning: Boolean(job.variablesRunning),
  };
}

function pythonArgs(args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: process.env.PYTHON_BIN || 'python',
    args: [runnerPath, ...args],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  };
}

function consumeLines(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  let index: number;
  while ((index = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, index).trim();
    rest = rest.slice(index + 1);
    if (line) onLine(line);
  }
  return rest;
}

function startJob(
  job: TrafficJob,
  kind: 'fetch' | 'collect',
  options: { ip: string; port: number; timeout: number; duration?: number; stu?: string; stuName?: string },
): void {
  const args = [
    kind,
    '--ip', options.ip,
    '--port', String(options.port),
    '--timeout', String(options.timeout),
    '--out-root', dataRoot,
  ];
  if (kind === 'collect') args.push('--duration', String(options.duration ?? 10));
  if (kind === 'fetch' && options.stu) {
    args.push('--stu', options.stu);
    if (options.stuName) args.push('--stu-name', options.stuName);
  }

  const { command, args: spawnArgs, env } = pythonArgs(args);
  const child = spawn(command, spawnArgs, { cwd: pythonDir, env, windowsHide: true });
  job.child = child;

  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    job.error = `解析超时（${Math.round(JOB_TIMEOUT_MS / 1000)} 秒），请检查 PLC 网络后重试`;
    child.kill();
  }, JOB_TIMEOUT_MS);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    stdout = consumeLines(stdout, (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = event.type;
      if (type === 'progress') {
        job.stage = String(event.stage ?? job.stage);
        job.percent = Number(event.percent ?? job.percent);
        job.message = String(event.message ?? '');
        job.updatedAt = Date.now();
      } else if (type === 'warning') {
        if (job.warnings.length < 20) job.warnings.push(String(event.message ?? ''));
      } else if (type === 'result') {
        job.result = event as unknown as TrafficResult;
        job.percent = 100;
        job.updatedAt = Date.now();
      } else if (type === 'error') {
        job.error = String(event.message ?? '解析失败');
        job.updatedAt = Date.now();
      }
    });
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });

  child.on('error', (error) => {
    clearTimeout(timer);
    job.status = 'error';
    job.error = job.error || `无法启动 Python：${error.message}。请确认已安装 Python 3，或设置 PYTHON_BIN。`;
    job.updatedAt = Date.now();
    void cleanupIncoming(job);
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (job.status === 'running') {
      if (code === 0 && job.result) {
        job.status = 'done';
        job.stage = 'done';
        job.percent = 100;
        job.message = job.message || '解析完成';
        const result = job.result;
        console.log(
          `[traffic] ${result.plc} 控制程序提取完成：${result.imageBytes} 字节 / `
          + `${result.records} 条记录 / SHA-256 ${result.sha256} / ${result.units?.length ?? 0} 个单元`,
        );
      } else {
        job.status = 'error';
        job.error = job.error
          || stderr.trim().split('\n').slice(-4).join('\n')
          || `解析进程退出（code ${code ?? 'unknown'}）`;
      }
    }
    job.updatedAt = Date.now();
    void cleanupIncoming(job);
  });
}

async function cleanupIncoming(job: TrafficJob): Promise<void> {
  if (!job.incomingStu) return;
  const path = job.incomingStu;
  job.incomingStu = undefined;
  await rm(path, { force: true }).catch(() => undefined);
}

function runVariablesForDir(runDir: string): Promise<TrafficVariable[]> {
  const { command, args, env } = pythonArgs(['variables', '--run-dir', runDir]);

  return new Promise<TrafficVariable[]>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: pythonDir, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let result: TrafficVariable[] | null = null;
    let errorMessage = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('变量提取超时，请重试'));
    }, VARIABLES_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = consumeLines(stdout + chunk, (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === 'result' && Array.isArray(event.variables)) {
          result = event.variables as TrafficVariable[];
        } else if (event.type === 'error') {
          errorMessage = String(event.message ?? '变量提取失败');
        }
      });
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 Python：${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && result) {
        resolvePromise(result);
      } else {
        reject(new Error(errorMessage || stderr.trim() || `变量提取进程退出（code ${code ?? 'unknown'}）`));
      }
    });
  });
}

function runParse(runDir: string): Promise<Record<string, unknown>> {
  const { command, args, env } = pythonArgs(['parse', '--run-dir', runDir]);

  return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: pythonDir, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let result: Record<string, unknown> | null = null;
    let errorMessage = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('离线解析超时，请重试'));
    }, 60_000);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = consumeLines(stdout + chunk, (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === 'result') {
          result = event;
        } else if (event.type === 'error') {
          errorMessage = String(event.message ?? '离线解析失败');
        }
      });
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 Python：${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && result) {
        resolvePromise(result);
      } else {
        reject(new Error(errorMessage || stderr.trim() || `离线解析进程退出（code ${code ?? 'unknown'}）`));
      }
    });
  });
}

async function createJob(
  req: IncomingMessage,
  res: ServerResponse,
  kind: 'fetch' | 'collect',
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      fail(res, 413, 'body_too_large', '请求体过大，.stu 文件请控制在 20 MB 以内');
      return;
    }
    fail(res, 400, 'invalid_json', '请求体不是有效的 JSON');
    return;
  }

  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!ip || isIP(ip) === 0) {
    fail(res, 400, 'invalid_ip', '请填写合法的 PLC IPv4 / IPv6 地址');
    return;
  }

  const portRaw = Number(body.port ?? 502);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    fail(res, 400, 'invalid_port', '端口必须是 1–65535 的整数');
    return;
  }

  const timeoutRaw = Number(body.timeout ?? 10);
  if (!Number.isFinite(timeoutRaw) || timeoutRaw < 1 || timeoutRaw > 60) {
    fail(res, 400, 'invalid_timeout', '超时时间必须在 1–60 秒之间');
    return;
  }

  const durationRaw = Number(body.duration ?? 10);
  if (!Number.isFinite(durationRaw) || durationRaw < 1 || durationRaw > 60) {
    fail(res, 400, 'invalid_duration', '采集时长必须在 1–60 秒之间');
    return;
  }

  const job: TrafficJob = {
    id: randomUUID(),
    status: 'running',
    stage: 'connect',
    percent: 0,
    message: '准备连接 PLC',
    error: '',
    warnings: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const stuName = typeof body.stuName === 'string' ? body.stuName.trim() : '';

  try {
    if (kind === 'fetch' && typeof body.stuBase64 === 'string' && body.stuBase64) {
      const data = Buffer.from(body.stuBase64, 'base64');
      if (data.length === 0) throw new Error('empty');
      if (data.length > 20 * 1024 * 1024) {
        fail(res, 413, 'stu_too_large', '.stu 文件超过 20 MB');
        return;
      }
      if (!data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        fail(res, 400, 'invalid_stu', '.stu 不是有效的 ZIP 工程文件');
        return;
      }
      await mkdir(incomingRoot, { recursive: true });
      const path = resolve(incomingRoot, `${job.id}.stu`);
      await writeFile(path, data);
      job.incomingStu = path;
    }
  } catch (error) {
    fail(res, 400, 'invalid_stu', `无法读取 .stu：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  jobs.set(job.id, job);
  startJob(job, kind, {
    ip,
    port: portRaw,
    timeout: timeoutRaw,
    duration: durationRaw,
    stu: job.incomingStu,
    stuName: stuName || undefined,
  });
  send(res, 202, { id: job.id });
}

async function extractVariables(job: TrafficJob, res: ServerResponse): Promise<void> {
  if (job.status !== 'done' || !job.result) {
    fail(res, 409, 'not_ready', '请先完成控制程序解析');
    return;
  }
  if (job.variablesRunning) {
    fail(res, 409, 'busy', '变量提取正在进行');
    return;
  }

  job.variablesRunning = true;
  job.variablesError = undefined;
  try {
    const variables = await runVariablesForDir(job.result.runDir);
    job.variables = variables;
    send(res, 200, { variables, runDir: job.result.runDir });
  } catch (error) {
    job.variablesError = error instanceof Error ? error.message : String(error);
    fail(res, 500, 'variables_failed', job.variablesError);
  } finally {
    job.variablesRunning = false;
    job.updatedAt = Date.now();
  }
}

const RUN_NAME_RE = /^[0-9A-Za-z._-]+$/;

function runDirFor(name: string): string | null {
  if (!RUN_NAME_RE.test(name) || name.startsWith('.')) return null;
  const dir = resolve(dataRoot, name);
  if (!dir.startsWith(`${dataRoot}${sep}`)) return null;
  return dir;
}

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readRunVariables(dir: string): Promise<TrafficVariable[] | null> {
  try {
    const value = JSON.parse(await readFile(join(dir, '03_变量', '变量表.json'), 'utf8')) as {
      variables?: unknown;
    };
    return Array.isArray(value.variables) ? (value.variables as TrafficVariable[]) : null;
  } catch {
    return null;
  }
}

async function listRuns(): Promise<TrafficRunSummary[]> {
  let entries;
  try {
    entries = await readdir(dataRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: TrafficRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !RUN_NAME_RE.test(entry.name)) continue;
    const dir = join(dataRoot, entry.name);
    const manifest = await readManifest(dir);
    if (!manifest) continue;

    const info = await stat(dir).catch(() => null);
    const variables = await readRunVariables(dir);
    const units = Array.isArray(manifest.units) ? manifest.units : [];
    const hasSources = await stat(join(dir, '02_逆向'))
      .then((value) => value.isDirectory())
      .catch(() => false);
    const traffic = (manifest.traffic && typeof manifest.traffic === 'object'
      ? manifest.traffic
      : {}) as Record<string, unknown>;
    runs.push({
      name: entry.name,
      plc: String(manifest.plc ?? ''),
      time: String(manifest.time ?? ''),
      imageBytes: Number(manifest.image_bytes ?? 0),
      records: Number(manifest.records ?? 0),
      sha256: String(manifest.sha256 ?? ''),
      unitCount: units.length,
      variableCount: variables?.length ?? 0,
      hasVariables: variables !== null,
      parsed: Boolean(manifest.parsed) || hasSources,
      frameCount: Number(traffic.frames ?? 0),
      trafficBytes: Number(traffic.bytes ?? 0),
      modifiedAt: info ? info.mtime.toISOString() : '',
    });
  }

  runs.sort((a, b) => (b.modifiedAt || b.name).localeCompare(a.modifiedAt || a.name));
  return runs;
}

async function loadRun(name: string): Promise<TrafficRunDetail | null> {
  const dir = runDirFor(name);
  if (!dir) return null;
  const manifest = await readManifest(dir);
  if (!manifest) return null;

  const sourceDir = join(dir, '02_逆向');
  let files: string[] = [];
  try {
    files = (await readdir(sourceDir))
      .filter((file) => file.endsWith('.st'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    files = [];
  }

  const meta = Array.isArray(manifest.units)
    ? (manifest.units as Array<Record<string, unknown>>)
    : [];
  const units: TrafficUnit[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const text = await readFile(join(sourceDir, files[i]), 'utf8').catch(() => '');
    const info = meta[i] ?? {};
    const offset = files[i].match(/0x([0-9A-Fa-f]+)/)?.[1];
    units.push({
      index: i + 1,
      name: String(info.name ?? (offset ? `单元 ${offset}` : `单元 ${i + 1}`)),
      kind: String(info.kind ?? '功能块'),
      chars: text.length,
      status: '解析成功',
      declared: Boolean(info.declared),
      streamOffset: offset ? `0x${offset}` : '',
      text,
    });
  }

  let traffic: TrafficResult['traffic'] = null;
  try {
    const value = JSON.parse(await readFile(join(dir, '流量', 'frames.json'), 'utf8')) as {
      frames?: unknown;
      points?: unknown;
      stats?: unknown;
    };
    traffic = {
      file: join(dir, '流量', '采集流量.pcapng'),
      frames: Array.isArray(value.frames) ? (value.frames as TrafficFrame[]) : [],
      points: Array.isArray(value.points) ? (value.points as TrafficPoint[]) : [],
      stats: (value.stats && typeof value.stats === 'object'
        ? value.stats
        : {}) as TrafficStats,
    };
  } catch {
    traffic = null;
  }

  const result: TrafficResult = {
    plc: String(manifest.plc ?? ''),
    port: Number(manifest.port ?? 502),
    session: String(manifest.session ?? ''),
    imageBytes: Number(manifest.image_bytes ?? 0),
    records: Number(manifest.records ?? 0),
    sha256: String(manifest.sha256 ?? ''),
    declarations: Boolean(manifest.stu) || units.some((unit) => unit.declared),
    stu: manifest.stu ? String(manifest.stu) : null,
    runDir: dir,
    units,
    parsed: Boolean(manifest.parsed) || files.length > 0,
    traffic,
  };

  return { name, result, variables: await readRunVariables(dir) };
}

export async function trafficMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  _next: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = url.pathname;
  if (pathname.startsWith('/api/traffic')) pathname = pathname.slice('/api/traffic'.length) || '/';

  try {
    if (pathname === '/runs' && req.method === 'GET') {
      send(res, 200, { runs: await listRuns() });
      return;
    }

    const runParseMatch = pathname.match(/^\/runs\/([0-9A-Za-z._-]+)\/parse$/);
    if (runParseMatch && req.method === 'POST') {
      const name = runParseMatch[1];
      const dir = runDirFor(name);
      if (!dir || !(await readManifest(dir))) {
        fail(res, 404, 'not_found', '运行记录不存在');
        return;
      }
      try {
        const result = await runParse(dir);
        send(res, 200, { name, result });
      } catch (error) {
        fail(res, 500, 'parse_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const runTrafficMatch = pathname.match(/^\/runs\/([0-9A-Za-z._-]+)\/traffic$/);
    if (runTrafficMatch && req.method === 'GET') {
      const name = runTrafficMatch[1];
      const dir = runDirFor(name);
      if (!dir) {
        fail(res, 404, 'not_found', '运行记录不存在');
        return;
      }
      try {
        const body = await readFile(join(dir, '流量', '采集流量.pcapng'));
        res.writeHead(200, {
          'content-type': 'application/vnd.tcpdump.pcapng',
          'content-length': body.byteLength,
          'content-disposition': `attachment; filename="${name}.pcapng"`,
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        fail(res, 404, 'not_found', '没有采集流量文件');
      }
      return;
    }

    const runVarMatch = pathname.match(/^\/runs\/([0-9A-Za-z._-]+)\/variables$/);
    if (runVarMatch && req.method === 'POST') {
      const name = runVarMatch[1];
      const dir = runDirFor(name);
      if (!dir || !(await readManifest(dir))) {
        fail(res, 404, 'not_found', '运行记录不存在');
        return;
      }
      try {
        const variables = await runVariablesForDir(dir);
        send(res, 200, { name, runDir: dir, variables });
      } catch (error) {
        fail(res, 500, 'variables_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const runMatch = pathname.match(/^\/runs\/([0-9A-Za-z._-]+)$/);
    if (runMatch && req.method === 'GET') {
      const detail = await loadRun(runMatch[1]);
      if (!detail) {
        fail(res, 404, 'not_found', '运行记录不存在');
        return;
      }
      send(res, 200, detail);
      return;
    }

    if (pathname === '/collect' && req.method === 'POST') {
      await createJob(req, res, 'collect');
      return;
    }

    if (pathname === '/jobs' && req.method === 'POST') {
      await createJob(req, res, 'fetch');
      return;
    }

    const jobMatch = pathname.match(/^\/jobs\/([0-9a-f-]{36})$/);
    if (jobMatch && req.method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        fail(res, 404, 'not_found', '任务不存在或已过期');
        return;
      }
      send(res, 200, publicJob(job));
      return;
    }

    const varMatch = pathname.match(/^\/jobs\/([0-9a-f-]{36})\/variables$/);
    if (varMatch && req.method === 'POST') {
      const job = jobs.get(varMatch[1]);
      if (!job) {
        fail(res, 404, 'not_found', '任务不存在或已过期');
        return;
      }
      await extractVariables(job, res);
      return;
    }

    fail(res, 404, 'not_found', '接口不存在');
  } catch (error) {
    console.error('[traffic]', error);
    fail(res, 500, 'internal_error', `解析服务内部错误：${error instanceof Error ? error.message : String(error)}`);
  }
}
