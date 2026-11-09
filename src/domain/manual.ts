import { z } from 'zod';

/** 手册抽取的公共词表。模型偶尔会改写措辞，这里只用于归并展示，不做强制校验。 */
export const DEVICE_TYPES = ['控制器', '操作员站', '工程师站', '被控物理过程', '传感器', '执行器'] as const;
export const DEVICE_LOCATIONS = ['行为主体', '行为客体', '行为主体和行为客体'] as const;
export const ACTION_TYPES = ['读', '写'] as const;
export const TARGET_TYPES = ['改变行为客体的输入', '改变行为客体的输出', '改变行为客体的设定值'] as const;
export const VALUE_TYPES = ['连续', '离散'] as const;
export const TRIGGER_TYPES = ['周期式', '中断式'] as const;

const textField = z.preprocess((value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}, z.string());

export const manualDeviceSchema = z.object({
  name: textField,
  location: textField,
  type: textField,
  evidence: textField,
});
export type ManualDevice = z.infer<typeof manualDeviceSchema>;

export const manualTopologySchema = z.object({
  subject: textField,
  subjectType: textField,
  object: textField,
  objectType: textField,
  actionType: textField,
  content: textField,
  targetType: textField,
  targetParam: textField,
  targetValue: textField,
  operationObject: textField,
  valueType: textField,
  valueRange: textField,
  valueMin: textField,
  valueMax: textField,
  valueUnit: textField,
  valueNominal: textField,
  evidence: textField,
});
export type ManualTopologyRow = z.infer<typeof manualTopologySchema>;

export const manualLogicSchema = manualTopologySchema.extend({
  triggerCause: textField,
  triggerType: textField,
  triggerResult: textField,
});
export type ManualLogicRow = z.infer<typeof manualLogicSchema>;

export type ManualStage = 'devices' | 'topology' | 'logic';

export interface ManualSegment {
  index: number;
  pageStart: number;
  pageEnd: number;
  text: string;
  chars: number;
}

export interface ManualSegmentExtraction {
  index: number;
  pageStart: number;
  pageEnd: number;
  devices: ManualDevice[];
  topology: ManualTopologyRow[];
  logic: ManualLogicRow[];
  issues: string[];
  /** 各阶段模型原始输出，随 JSON 导出，便于复核解析是否丢失内容。 */
  raw?: Partial<Record<ManualStage, string>>;
}

export interface ManualExtraction {
  schemaVersion: 1;
  source: string;
  exportedAt: string;
  model: string;
  segments: ManualSegmentExtraction[];
}

export interface Sourced<T> {
  row: T;
  sources: number[];
}

export interface ManualMerged {
  devices: Sourced<ManualDevice>[];
  topology: Sourced<ManualTopologyRow>[];
  logic: Sourced<ManualLogicRow>[];
}

/** 词表归一：只处理常见的同义写法，未命中时保留原文。 */
export function canonicalDeviceType(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text.includes('控制器') || /^(PLC|DCS|SIS)$/i.test(text)) return '控制器';
  if (text.includes('操作员')) return '操作员站';
  if (text.includes('工程师')) return '工程师站';
  if (text.includes('传感器') || text.includes('变送器') || text.includes('检测仪')) return '传感器';
  if (text.includes('执行器') || text.includes('阀门') || text.includes('电动阀') || text.includes('泵') || text.includes('风机')) return '执行器';
  if (text.includes('过程') || text.includes('对象')) return '被控物理过程';
  return text;
}

export function canonicalLocation(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text.includes('主体') && text.includes('客体')) return '行为主体和行为客体';
  if (text.includes('主体')) return '行为主体';
  if (text.includes('客体')) return '行为客体';
  return text;
}

export function canonicalActionType(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text === '写' || text.includes('写入') || text.toLowerCase() === 'write') return '写';
  if (text === '读' || text.includes('读取') || text.toLowerCase() === 'read') return '读';
  return text;
}

export function canonicalTriggerType(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text.includes('周期')) return '周期式';
  if (text.includes('中断') || text.includes('事件') || text.includes('条件')) return '中断式';
  return text;
}

export function canonicalValueType(value: string): string {
  const text = value.trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  if (text.includes('连续') || text.includes('模拟') || lower.includes('continuous') || lower.includes('analog')) return '连续';
  if (text.includes('离散') || text.includes('开关') || text.includes('枚举') || lower.includes('discrete')) return '离散';
  return text;
}

export function canonicalRow<T extends ManualTopologyRow>(row: T): T {
  return {
    ...row,
    subjectType: canonicalDeviceType(row.subjectType),
    objectType: canonicalDeviceType(row.objectType),
    actionType: canonicalActionType(row.actionType),
    operationObject: row.operationObject || row.targetParam,
    valueType: canonicalValueType(row.valueType),
  };
}

export function canonicalLogicRow(row: ManualLogicRow): ManualLogicRow {
  return { ...canonicalRow(row), triggerType: canonicalTriggerType(row.triggerType) };
}

export function canonicalDeviceRow(row: ManualDevice): ManualDevice {
  return { ...row, type: canonicalDeviceType(row.type), location: canonicalLocation(row.location) };
}

export function formatValueRange(
  row: Pick<ManualTopologyRow, 'valueRange' | 'valueMin' | 'valueMax' | 'valueUnit' | 'valueNominal'>,
): string {
  const unit = row.valueUnit.trim();
  const min = row.valueMin.trim();
  const max = row.valueMax.trim();
  let range = row.valueRange.trim();

  if (!range && (min || max)) {
    if (min && max) range = `${min}～${max}`;
    else if (min) range = `≥ ${min}`;
    else range = `≤ ${max}`;
    if (unit) range += ` ${unit}`;
  }

  const nominal = row.valueNominal.trim();
  const parts: string[] = [];
  if (range) parts.push(range);
  if (nominal) {
    const hasUnit = Boolean(unit) && range.includes(unit);
    parts.push(`额定 ${nominal}${unit && !hasUnit ? ` ${unit}` : ''}`);
  }
  return parts.join('；');
}

export function formatValueRangeCell(
  row: Pick<ManualTopologyRow, 'valueType' | 'valueRange' | 'valueMin' | 'valueMax' | 'valueUnit' | 'valueNominal'>,
): string {
  const range = formatValueRange(row);
  return [row.valueType.trim(), range].filter(Boolean).join(' · ');
}

const SEP = '\u0001';

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function rowKey(value: object): string {
  return Object.values(value as Record<string, unknown>).map((v) => cellText(v).replace(/\s+/g, ' ').trim()).join(SEP);
}

/**
 * 跨分段合并。重叠页面会让同一条逻辑被抽取多次，这里按“全部字段相同”去重，
 * 并记录来源分段，便于回查原文。
 */
export function mergeExtractions(segments: ManualSegmentExtraction[]): ManualMerged {
  const devices = new Map<string, Sourced<ManualDevice>>();
  const topology = new Map<string, Sourced<ManualTopologyRow>>();
  const logic = new Map<string, Sourced<ManualLogicRow>>();

  const add = <T>(map: Map<string, Sourced<T>>, row: T, index: number, key: (row: T) => string) => {
    const k = key(row);
    const hit = map.get(k);
    if (hit) {
      if (!hit.sources.includes(index)) hit.sources.push(index);
      return;
    }
    map.set(k, { row, sources: [index] });
  };

  for (const segment of segments) {
    for (const row of segment.devices) add(devices, row, segment.index, (r) => `${r.name}${SEP}${r.type}`);
    for (const row of segment.topology) add(topology, row, segment.index, rowKey);
    for (const row of segment.logic) add(logic, row, segment.index, rowKey);
  }

  const bySources = <T>(a: Sourced<T>, b: Sourced<T>) => a.sources[0] - b.sources[0];
  return {
    devices: [...devices.values()].sort(bySources),
    topology: [...topology.values()].sort(bySources),
    logic: [...logic.values()].sort(bySources),
  };
}

export function emptyMerged(): ManualMerged {
  return { devices: [], topology: [], logic: [] };
}

export function countRows(merged: ManualMerged): { devices: number; topology: number; logic: number; total: number } {
  return {
    devices: merged.devices.length,
    topology: merged.topology.length,
    logic: merged.logic.length,
    total: merged.devices.length + merged.topology.length + merged.logic.length,
  };
}

function mdCell(value: string): string {
  return (value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function markdownTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return '（无）\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`),
    '',
  ].join('\n');
}

export function buildMarkdown(extraction: ManualExtraction, merged: ManualMerged): string {
  const lines: string[] = [
    '# 操作手册逻辑抽取结果',
    '',
    `- 来源文件：${extraction.source}`,
    `- 导出时间：${extraction.exportedAt}`,
    `- 模型：${extraction.model}`,
    `- 分段数量：${extraction.segments.length}`,
    '- 定级说明：本结果由大模型从操作手册中抽取，仅作人工复核的初稿，不自动写入 VeriPro 测试归档。',
    '',
    '## 设备清单',
    '',
    markdownTable(
      ['设备名称', '设备定位', '设备类型', '原文依据', '来源分段'],
      merged.devices.map(({ row, sources }) => [row.name, row.location, row.type, row.evidence, sources.join(', ')]),
    ),
    '## 业务拓扑',
    '',
    markdownTable(
      ['行为主体', '主体类型', '行为客体', '客体类型', '行为类型', '行为内容', '行为目标类型', '目标参数', '目标参数值', '操作对象', '操作值域', '原文依据', '来源分段'],
      merged.topology.map(({ row, sources }) => [row.subject, row.subjectType, row.object, row.objectType, row.actionType, row.content, row.targetType, row.targetParam, row.targetValue, row.operationObject, formatValueRangeCell(row), row.evidence, sources.join(', ')]),
    ),
    '## 控制逻辑',
    '',
    markdownTable(
      ['行为主体', '主体类型', '行为客体', '客体类型', '行为类型', '行为内容', '行为目标类型', '目标参数', '目标参数值', '操作对象', '操作值域', '触发原因', '触发类型', '触发结果', '原文依据', '来源分段'],
      merged.logic.map(({ row, sources }) => [row.subject, row.subjectType, row.object, row.objectType, row.actionType, row.content, row.targetType, row.targetParam, row.targetValue, row.operationObject, formatValueRangeCell(row), row.triggerCause, row.triggerType, row.triggerResult, row.evidence, sources.join(', ')]),
    ),
    '## 分段明细',
    '',
    ...extraction.segments.map((segment) => [
      `### 分段 ${segment.index}（第 ${segment.pageStart}–${segment.pageEnd} 页）`,
      '',
      `- 设备：${segment.devices.length} 条`,
      `- 业务拓扑：${segment.topology.length} 条`,
      `- 控制逻辑：${segment.logic.length} 条`,
      segment.issues.length ? `- 解析提示：${segment.issues.join('；')}` : '',
      '',
    ].filter(Boolean).join('\n')),
  ];
  return lines.join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename: string, value: unknown) {
  downloadText(filename, JSON.stringify(value, null, 2), 'application/json;charset=utf-8');
}
