import type { TrafficJobInput, TrafficJobView, TrafficVariable } from '@/domain/traffic';

export class TrafficApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'TrafficApiError';
    this.code = options.code ?? 'unknown';
    this.status = options.status ?? 0;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function request(input: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw new TrafficApiError(
      `无法连接解析服务：${error instanceof Error ? error.message : String(error)}`,
      { code: 'network' },
    );
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new TrafficApiError(
      typeof body.error === 'string' ? body.error : `解析服务返回 ${response.status}`,
      { code: typeof body.code === 'string' ? body.code : 'upstream_error', status: response.status },
    );
  }
  return body;
}

export async function startTrafficJob(input: TrafficJobInput): Promise<{ id: string }> {
  const body = await request('/api/traffic/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ip: input.ip,
      port: input.port,
      timeout: input.timeout,
    }),
  });

  if (typeof body.id !== 'string') {
    throw new TrafficApiError('解析服务没有返回任务编号', { code: 'invalid_response' });
  }
  return { id: body.id };
}

export async function fetchTrafficJob(id: string): Promise<TrafficJobView> {
  const body = await request(`/api/traffic/jobs/${encodeURIComponent(id)}`, {
    method: 'GET',
    cache: 'no-store',
  });
  return body as unknown as TrafficJobView;
}

export async function extractTrafficVariables(id: string): Promise<TrafficVariable[]> {
  const body = await request(`/api/traffic/jobs/${encodeURIComponent(id)}/variables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return Array.isArray(body.variables) ? (body.variables as TrafficVariable[]) : [];
}
