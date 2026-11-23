export interface TrafficUnit {
  index: number;
  name: string;
  kind: string;
  chars: number;
  status: string;
  declared: boolean;
  streamOffset: string;
  text: string;
  plc?: string;
}

export type TrafficCategory = 'upload' | 'runtime' | 'io';

export interface TrafficFrame {
  index: number;
  time: string;
  direction: 'request' | 'response';
  category: TrafficCategory;
  protocol: string;
  function: string;
  summary: string;
  bytes: number;
  hex: string;
  recordIndex?: number | null;
  address?: string;
  count?: number;
  values?: number[] | null;
}

export interface TrafficPoint {
  category: TrafficCategory;
  area: string;
  address: string;
  value: number;
}

export interface TrafficRange {
  category: TrafficCategory;
  area: string;
  start: number;
  end: number;
}

export interface TrafficStats {
  frames: number;
  bytes: number;
  upload: { frames: number; bytes: number };
  runtime: { frames: number; bytes: number };
  io: { frames: number; bytes: number };
  samples: number;
  duration_ms: number;
  client_ip: string;
  ranges: TrafficRange[];
}

export interface TrafficCollection {
  file: string;
  frames: TrafficFrame[];
  points: TrafficPoint[];
  stats: TrafficStats;
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
  plcs?: string[];
  traffic?: TrafficCollection | null;
}

export interface TrafficVariable {
  unit: string;
  name: string;
  type: string;
  category: string;
  range: string;
  basis: string;
  inferred?: boolean;
}

export type TrafficJobStatus = 'running' | 'done' | 'error';

export interface TrafficJobView {
  id: string;
  status: TrafficJobStatus;
  stage: string;
  percent: number;
  message: string;
  error: string;
  warnings: string[];
  result?: TrafficResult;
  variables?: TrafficVariable[];
  variablesError?: string;
  variablesRunning?: boolean;
}

export interface TrafficJobInput {
  ip: string;
  port: number;
  timeout: number;
  duration?: number;
  plcs?: string[];
}

export type TrafficQualityLevel = '高' | '中' | '低';

export interface TrafficQuality {
  score: number;
  level: TrafficQualityLevel;
}

export interface TrafficQualitySummary {
  total: number;
  average: number;
  high: number;
  mid: number;
  low: number;
  withRange: number;
}

export interface TrafficRunSummary {
  name: string;
  plc: string;
  time: string;
  imageBytes: number;
  records: number;
  sha256: string;
  unitCount: number;
  variableCount: number;
  hasVariables: boolean;
  parsed: boolean;
  plcs?: string[];
  frameCount: number;
  trafficBytes: number;
  modifiedAt: string;
}

export interface TrafficRunDetail {
  name: string;
  result: TrafficResult;
  variables: TrafficVariable[] | null;
}

/** 质量分：值域、类型、类别、依据四项，缺项或推断项扣分。 */
export function variableQuality(row: TrafficVariable): TrafficQuality {
  let score = 100;

  const range = (row.range ?? '').trim();
  if (!range || range === '未定') score -= 35;
  else if (range.startsWith('相关常量')) score -= 10;

  const type = (row.type ?? '').trim();
  if (!type || type === '未知') score -= 20;
  else if (row.inferred || type.includes('推断')) score -= 5;

  const category = (row.category ?? '').trim();
  if (!category || category === '未知') score -= 10;
  else if (row.inferred || category.includes('推断')) score -= 5;

  const basis = (row.basis ?? '').trim();
  if (!basis || basis === '无法从源码推断') score -= 15;

  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    level: bounded >= 80 ? '高' : bounded >= 60 ? '中' : '低',
  };
}

export function summarizeQuality(rows: TrafficVariable[]): TrafficQualitySummary {
  const levels = rows.map(variableQuality);
  const total = rows.length;
  const average = total ? Math.round(levels.reduce((sum, item) => sum + item.score, 0) / total) : 0;
  return {
    total,
    average,
    high: levels.filter((item) => item.level === '高').length,
    mid: levels.filter((item) => item.level === '中').length,
    low: levels.filter((item) => item.level === '低').length,
    withRange: rows.filter((row) => row.range && row.range !== '未定').length,
  };
}
