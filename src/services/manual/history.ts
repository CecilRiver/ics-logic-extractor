import type { ManualRunMeta, ManualRunSummary } from '@/domain/manual';
import { ManualApiError } from './client';
import type { SegmentRun } from './orchestrator';

export interface ManualRunPayload {
  source: string;
  model: string;
  fileMeta: { name: string; size: number; kind: 'pdf' | 'text'; pageCount: number };
  options: { pagesPerSegment: number; maxChars: number; headerPct: number; footerPct: number };
  segments: Array<{ index: number; pageStart: number; pageEnd: number; chars: number; status: string }>;
  pages: string[];
  runs: SegmentRun[];
}

export interface ManualRunDetail {
  name: string;
  meta: ManualRunMeta;
  pages: string[];
  runs: SegmentRun[];
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
    throw new ManualApiError(
      `无法连接历史服务：${error instanceof Error ? error.message : String(error)}`,
      { code: 'network', fatal: false },
    );
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new ManualApiError(
      typeof body.error === 'string' ? body.error : `历史服务返回 ${response.status}`,
      { code: typeof body.code === 'string' ? body.code : 'history_error', status: response.status },
    );
  }
  return body;
}

export async function saveManualRun(payload: ManualRunPayload, name?: string): Promise<string> {
  const url = name ? `/api/manual/runs/${encodeURIComponent(name)}` : '/api/manual/runs';
  const body = await request(url, {
    method: name ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const saved = typeof body.name === 'string' ? body.name : name;
  if (!saved) throw new ManualApiError('历史服务没有返回记录名', { code: 'invalid_response' });
  return saved;
}

export async function listManualRuns(): Promise<ManualRunSummary[]> {
  const body = await request('/api/manual/runs', { method: 'GET', cache: 'no-store' });
  return Array.isArray(body.runs) ? (body.runs as ManualRunSummary[]) : [];
}

export async function loadManualRun(name: string): Promise<ManualRunDetail> {
  return (await request(`/api/manual/runs/${encodeURIComponent(name)}`, {
    method: 'GET',
    cache: 'no-store',
  })) as unknown as ManualRunDetail;
}

export async function deleteManualRun(name: string): Promise<void> {
  await request(`/api/manual/runs/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
