import {
  canonicalDeviceRow,
  canonicalLogicRow,
  canonicalRow,
  manualDeviceSchema,
  manualLogicSchema,
  manualTopologySchema,
  type ManualDevice,
  type ManualLogicRow,
  type ManualStage,
  type ManualTopologyRow,
} from '../../domain/manual.ts';

export interface ParseResult<T> {
  rows: T[];
  issues: string[];
  ok: boolean;
}

const ROW_MISSING = '模型输出不是有效的 JSON 对象';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedKey(key: string): string {
  return key.replace(/[\s_-]/g, '').toLowerCase();
}

function lookup(record: Record<string, unknown>, keys: string[]): unknown {
  const wanted = new Set(keys.map(normalizedKey));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalizedKey(key))) return value;
  }
  return undefined;
}

function firstBalanced(text: string, openAt: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return text.slice(openAt, i + 1);
    }
  }
  return null;
}

/** 从模型回复中取出 JSON；容忍代码围栏、前后说明文字、尾逗号与中文引号。 */
export function extractJson(raw: string): { value: unknown; issue?: string } {
  const source = raw.replace(/^﻿/, '').trim();
  if (!source) return { value: null, issue: '模型没有返回内容' };

  const cleaned = source
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  const attempts: string[] = [cleaned];
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(cleaned.slice(firstBrace, lastBrace + 1));
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) attempts.push(cleaned.slice(firstBracket, lastBracket + 1));

  let started = 0;
  let found = 0;
  while (found < 4) {
    const next = cleaned.slice(started).search(/\{|\[/);
    if (next < 0) break;
    const at = started + next;
    const balanced = firstBalanced(cleaned, at);
    if (balanced) attempts.push(balanced);
    started = at + 1;
    found += 1;
  }

  const repaired = attempts.map((value) => value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1'));

  for (const candidate of [...attempts, ...repaired]) {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // 继续尝试下一种切分/修复方式。
    }
  }
  return { value: null, issue: '模型输出无法解析为 JSON（可能被截断）' };
}

const ROOT_KEYS: Record<ManualStage, string[]> = {
  devices: ['devices', 'deviceList', '设备', '设备列表', '单点设备'],
  topology: ['topology', 'businessTopology', 'topologyList', '业务拓扑', '拓扑'],
  logic: ['logic', 'controlLogic', 'logicList', 'rules', '控制逻辑', '业务逻辑'],
};

const CONTAINER_KEYS = ['data', 'result', 'results', 'items', 'output', '抽取结果'];

function rowsFromRoot(stage: ManualStage, root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  const record = asRecord(root);
  if (!record) return [];

  for (const key of [...ROOT_KEYS[stage], ...CONTAINER_KEYS]) {
    const value = lookup(record, [key]);
    if (Array.isArray(value)) return value;
    if (asRecord(value)) {
      for (const nested of ROOT_KEYS[stage]) {
        const rows = lookup(value as Record<string, unknown>, [nested]);
        if (Array.isArray(rows)) return rows;
      }
    }
  }
  // 模型可能漏掉外层包装，直接返回单行对象。
  return Object.keys(record).length > 0 ? [record] : [];
}

const DEVICE_KEYS = {
  name: ['name', 'deviceName', '设备名称', '名称'],
  location: ['location', 'role', 'position', '设备定位', '定位'],
  type: ['type', 'deviceType', '设备类型', '类型'],
  evidence: ['evidence', 'source', 'quote', '原文依据', '依据', '原文'],
};

const TOPOLOGY_KEYS = {
  subject: ['subject', 'subjectName', 'subjectDevice', '行为主体', '行为主体的设备名称', '主体'],
  subjectType: ['subjectType', 'subjectDeviceType', '行为主体的设备类型', '主体类型'],
  object: ['object', 'objectName', 'objectDevice', '行为客体', '行为客体的设备名称', '客体'],
  objectType: ['objectType', 'objectDeviceType', '行为客体的设备类型', '客体类型'],
  actionType: ['actionType', 'action', '行为类型', '操作类型'],
  content: ['content', 'behavior', 'actionContent', '行为内容', '内容'],
  targetType: ['targetType', '行为目标类型', '目标类型'],
  targetParam: ['targetParam', 'targetParameter', 'paramName', '行为目标参数名称', '目标参数名称', '目标参数'],
  targetValue: ['targetValue', 'targetParamValue', 'paramValue', '行为目标参数值', '目标参数值'],
  operationObject: ['operationObject', 'operatedObject', 'targetObject', 'operationTarget', '操作对象', '被操作对象', '操作目标'],
  valueType: ['valueType', 'valueKind', 'rangeType', '值域类型', '取值类型'],
  valueRange: ['valueRange', 'operationRange', 'range', '操作值域', '值域', '取值范围', '允许范围', '操作范围'],
  valueMin: ['valueMin', 'min', 'minValue', 'lowerLimit', '下限', '最小值'],
  valueMax: ['valueMax', 'max', 'maxValue', 'upperLimit', '上限', '最大值'],
  valueUnit: ['valueUnit', 'unit', 'rangeUnit', '单位', '值域单位'],
  valueNominal: ['valueNominal', 'nominal', 'nominalValue', 'ratedValue', '额定值', '标称值', '典型值'],
  evidence: ['evidence', 'source', 'quote', '原文依据', '依据', '原文'],
};

const LOGIC_KEYS = {
  ...TOPOLOGY_KEYS,
  triggerCause: ['triggerCause', 'cause', '行为触发原因', '触发原因'],
  triggerType: ['triggerType', '行为触发类型', '触发类型'],
  triggerResult: ['triggerResult', 'resultEffect', '行为触发结果', '触发结果'],
};

function pickText(record: Record<string, unknown>, keys: string[]): string {
  const value = lookup(record, keys);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function parseRows<T>(stage: ManualStage, raw: string, build: (record: Record<string, unknown>) => T, keep: (row: T) => boolean): ParseResult<T> {
  const { value, issue } = extractJson(raw);
  if (issue || value == null) return { rows: [], issues: [issue ?? ROW_MISSING], ok: false };

  const rows: T[] = [];
  let skipped = 0;
  for (const item of rowsFromRoot(stage, value)) {
    const record = asRecord(item);
    if (!record) {
      skipped += 1;
      continue;
    }
    try {
      const parsed = build(record);
      if (keep(parsed)) rows.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  const issues: string[] = [];
  if (skipped) issues.push(`跳过 ${skipped} 条字段不完整或格式错误的记录`);
  if (!rows.length && !skipped) issues.push('本段未抽取到内容');
  return { rows, issues, ok: true };
}

export function parseDevices(raw: string): ParseResult<ManualDevice> {
  return parseRows(
    'devices',
    raw,
    (record) => {
      const candidate = { name: '', location: '', type: '', evidence: '' };
      for (const [key, aliases] of Object.entries(DEVICE_KEYS)) candidate[key as keyof typeof candidate] = pickText(record, aliases);
      return canonicalDeviceRow(manualDeviceSchema.parse(candidate));
    },
    (row) => row.name.length > 0,
  );
}

export function parseTopology(raw: string): ParseResult<ManualTopologyRow> {
  return parseRows(
    'topology',
    raw,
    (record) => {
      const candidate = {
        subject: '', subjectType: '', object: '', objectType: '', actionType: '',
        content: '', targetType: '', targetParam: '', targetValue: '',
        operationObject: '', valueType: '', valueRange: '', valueMin: '', valueMax: '',
        valueUnit: '', valueNominal: '', evidence: '',
      };
      for (const [key, aliases] of Object.entries(TOPOLOGY_KEYS)) candidate[key as keyof typeof candidate] = pickText(record, aliases);
      return canonicalRow(manualTopologySchema.parse(candidate));
    },
    (row) => Boolean(row.subject || row.object || row.content),
  );
}

export function parseLogic(raw: string): ParseResult<ManualLogicRow> {
  return parseRows(
    'logic',
    raw,
    (record) => {
      const candidate = {
        subject: '', subjectType: '', object: '', objectType: '', actionType: '',
        content: '', targetType: '', targetParam: '', targetValue: '',
        operationObject: '', valueType: '', valueRange: '', valueMin: '', valueMax: '',
        valueUnit: '', valueNominal: '', evidence: '',
        triggerCause: '', triggerType: '', triggerResult: '',
      };
      for (const [key, aliases] of Object.entries(LOGIC_KEYS)) candidate[key as keyof typeof candidate] = pickText(record, aliases);
      return canonicalLogicRow(manualLogicSchema.parse(candidate));
    },
    (row) => Boolean(row.subject || row.object || row.content || row.triggerCause),
  );
}

export function parseStage(stage: ManualStage, raw: string): ParseResult<ManualDevice | ManualTopologyRow | ManualLogicRow> {
  if (stage === 'devices') return parseDevices(raw);
  if (stage === 'topology') return parseTopology(raw);
  return parseLogic(raw);
}
