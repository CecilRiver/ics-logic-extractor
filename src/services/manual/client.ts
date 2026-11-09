import type { ManualDevice, ManualStage, ManualTopologyRow } from '../../domain/manual';

export interface ExtractPayload {
  stage: ManualStage;
  text: string;
  devices?: ManualDevice[];
  topology?: ManualTopologyRow[];
}

export interface ExtractResult {
  stage: ManualStage;
  raw: string;
  data: unknown[];
  issues: string[];
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface HealthResult {
  configured: boolean;
  model: string;
}

export class ManualApiError extends Error {
  readonly code: string;
  readonly fatal: boolean;
  readonly status: number;

  constructor(message: string, options: { code?: string; fatal?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'ManualApiError';
    this.code = options.code ?? 'unknown';
    this.fatal = options.fatal ?? false;
    this.status = options.status ?? 0;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new DOMException('请求已取消', 'AbortError'));
  }, { once: true });
});

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResult> {
  const response = await fetch('/api/manual/extract', { signal, cache: 'no-store' });
  if (!response.ok) throw new ManualApiError(`服务不可用（${response.status}）`, { fatal: true, status: response.status });
  const body = await readJson(response);
  return { configured: Boolean(body.configured), model: typeof body.model === 'string' ? body.model : '' };
}

/** 单阶段抽取。429/5xx 会自动重试一次；其余错误直接抛出。 */
export async function callExtract(payload: ExtractPayload, signal?: AbortSignal): Promise<ExtractResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(900, signal);
    try {
      const response = await fetch('/api/manual/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      const body = await readJson(response);
      if (!response.ok) {
        const message = typeof body.error === 'string' ? body.error : `抽取服务返回 ${response.status}`;
        const code = typeof body.code === 'string' ? body.code : 'upstream_error';
        const fatal = typeof body.fatal === 'boolean' ? body.fatal : response.status === 401 || response.status === 503;
        const error = new ManualApiError(message, { code, fatal, status: response.status });
        if (response.status === 429 || response.status >= 500) {
          lastError = error;
          if (response.status === 503 && fatal) throw error;
          continue;
        }
        throw error;
      }
      return {
        stage: payload.stage,
        raw: typeof body.raw === 'string' ? body.raw : '',
        data: Array.isArray(body.data) ? body.data : [],
        issues: Array.isArray(body.issues) ? body.issues.filter((v): v is string => typeof v === 'string') : [],
        model: typeof body.model === 'string' ? body.model : '',
        usage: body.usage && typeof body.usage === 'object' ? body.usage as ExtractResult['usage'] : undefined,
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof ManualApiError) {
        if (error.status === 429 || error.status >= 500) {
          lastError = error;
          continue;
        }
        throw error;
      }
      lastError = new ManualApiError(error instanceof Error ? error.message : String(error), { code: 'network', fatal: true });
    }
  }
  throw lastError instanceof ManualApiError
    ? lastError
    : new ManualApiError('抽取请求失败', { code: 'network', fatal: true });
}
