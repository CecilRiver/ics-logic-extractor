import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { manualDeviceSchema, manualTopologySchema } from '../src/domain/manual.ts';
import { parseStage } from '../src/services/manual/parser.ts';
import { buildMessages } from '../src/services/manual/prompts.ts';
import { loadEnv } from './env.ts';

loadEnv();

const requestSchema = z.object({
  stage: z.enum(['devices', 'topology', 'logic']),
  text: z.string().min(1).max(60000),
  devices: z.array(manualDeviceSchema).max(500).optional(),
  topology: z.array(manualTopologySchema).max(1000).optional(),
});

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readVar(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function modelName(): string {
  return readVar('DEEPSEEK_MODEL') || DEFAULT_MODEL;
}

function endpoint(): string {
  const base = (readVar('DEEPSEEK_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function numberVar(name: string, fallback: number, min: number, max: number): number {
  const value = Number(readVar(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

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

function fail(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  fatal = false,
): void {
  send(res, status, { error, code, fatal });
}

class BodyTooLargeError extends Error {
  constructor() {
    super('body_too_large');
    this.name = 'BodyTooLargeError';
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
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
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('client_aborted')));
  });
}

/**
 * GET  : 健康检查（是否配置 Key、当前模型）
 * POST : 单阶段抽取（devices → topology → logic）
 */
export async function handleManualExtract(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    send(res, 200, {
      configured: Boolean(readVar('DEEPSEEK_API_KEY')),
      model: modelName(),
    });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { error: '仅支持 GET 与 POST', code: 'method_not_allowed' });
    return;
  }

  const apiKey = readVar('DEEPSEEK_API_KEY');
  if (!apiKey) {
    fail(
      res,
      503,
      'missing_key',
      '未配置 DEEPSEEK_API_KEY。请在项目根目录 .env 中填写，或通过环境变量注入。',
      true,
    );
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      fail(res, 413, 'body_too_large', '请求体超过 2 MB，请缩小分段字符上限后重试。');
      return;
    }
    fail(res, 400, 'invalid_json', '请求体不是有效的 JSON');
    return;
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    fail(
      res,
      400,
      'invalid_request',
      `请求参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
    );
    return;
  }
  const input = parsed.data;

  const messages = buildMessages(input.stage, {
    text: input.text,
    devices: input.devices,
    topology: input.topology,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  const payload = {
    model: modelName(),
    messages,
    temperature: numberVar('DEEPSEEK_TEMPERATURE', 0.2, 0, 1.5),
    max_tokens: Math.round(numberVar('DEEPSEEK_MAX_TOKENS', 8192, 512, 8192)),
    stream: false,
  };

  try {
    let response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...payload, response_format: { type: 'json_object' } }),
      signal: controller.signal,
    });

    // 自定义兼容端点可能不支持 JSON mode；此时退回普通补全，仍由提示词约束输出。
    if (response.status === 400) {
      const text = await response.clone().text();
      if (text.includes('response_format')) {
        response = await fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      }
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        fail(
          res,
          502,
          'auth',
          'DeepSeek 鉴权失败，请检查 DEEPSEEK_API_KEY 是否正确、是否已过期。',
          true,
        );
        return;
      }
      if (response.status === 429) {
        fail(res, 429, 'rate_limit', 'DeepSeek 请求频率或额度受限，请稍后重试。');
        return;
      }
      const detail = (await response.text()).slice(0, 300);
      fail(
        res,
        502,
        'upstream_error',
        `DeepSeek 返回 ${response.status}：${detail || '无响应体'}`,
      );
      return;
    }

    const result = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };
    const raw = result.choices?.[0]?.message?.content ?? '';
    if (!raw.trim()) {
      fail(res, 502, 'empty_output', 'DeepSeek 返回了空内容，请重试。');
      return;
    }

    const output = parseStage(input.stage, raw);
    send(res, 200, {
      stage: input.stage,
      raw,
      data: output.rows,
      issues: output.issues,
      model: result.model ?? payload.model,
      usage: result.usage
        ? {
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            totalTokens: result.usage.total_tokens,
          }
        : undefined,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      if (timedOut) {
        fail(res, 504, 'timeout', '模型响应超时（120 秒），请缩小分段字符上限后重试。');
      } else {
        fail(res, 499, 'client_aborted', '请求已取消');
      }
      return;
    }
    fail(
      res,
      502,
      'network',
      `无法连接 DeepSeek：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}

/** 适配 Vite dev server 与 Node http server 的 Connect 风格中间件。 */
export async function manualExtractMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  try {
    await handleManualExtract(req, res);
  } catch (error) {
    console.error('[manual-extract]', error);
    if (!res.writableEnded) {
      send(res, 500, {
        error: `抽取服务内部错误：${error instanceof Error ? error.message : String(error)}`,
        code: 'internal_error',
        fatal: true,
      });
    }
    next?.();
  }
}
