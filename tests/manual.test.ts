import { describe, expect, it } from 'vitest';
import { buildMarkdown, formatValueRangeCell, mergeExtractions, type ManualSegmentExtraction } from '@/domain/manual';
import { buildSegments, splitText } from '@/services/manual/chunk';
import { parseDevices, parseLogic, parseTopology } from '@/services/manual/parser';

const page = (n: number, text = `第${n}页正文`) => `第 ${n} 页\n${text}`;

describe('manual chunking', () => {
  it('groups pages without duplicating the tail', () => {
    const segments = buildSegments([1, 2, 3, 4, 5].map((n) => page(n)), { pagesPerSegment: 4, maxChars: 12000 });
    expect(segments).toHaveLength(2);
    expect([segments[0].pageStart, segments[0].pageEnd]).toEqual([1, 4]);
    expect([segments[1].pageStart, segments[1].pageEnd]).toEqual([5, 5]);
    expect(segments[1].text).toContain('第 5 页');
    expect(segments[1].text).not.toContain('第 3 页');
  });

  it('ignores empty pages and keeps page numbers aligned to the source', () => {
    const segments = buildSegments(['', '正文 A', '', '正文 B'], { pagesPerSegment: 1, maxChars: 12000 });
    expect(segments).toHaveLength(2);
    expect([segments[0].pageStart, segments[0].pageEnd]).toEqual([2, 2]);
    expect([segments[1].pageStart, segments[1].pageEnd]).toEqual([4, 4]);
  });

  it('splits a page that exceeds the character budget', () => {
    const long = '阀门动作说明。'.repeat(400);
    const segments = buildSegments([long], { pagesPerSegment: 4, maxChars: 1000 });
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.chars).toBeLessThanOrEqual(1000);
      expect(segment.pageStart).toBe(1);
      expect(segment.pageEnd).toBe(1);
    }
    expect(segments.map((s) => s.text).join('')).toBe(long);
  });

  it('prefers paragraph boundaries when splitting long text', () => {
    const text = Array.from({ length: 80 }, (_, i) => `第 ${i} 段说明文字，包含控制器与执行器的动作。`).join('\n\n');
    const pieces = splitText(text, 1000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(1000);
      expect(piece.endsWith('。')).toBe(true);
    }
  });
});

describe('manual parser', () => {
  it('reads fenced JSON and drops rows without a device name', () => {
    const raw = '```json\n{"devices":[{"name":"给水泵","location":"行为客体","type":"电动阀门","evidence":"开启给水泵"},{"name":"","type":"控制器"}]}\n```';
    const result = parseDevices(raw);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ name: '给水泵', location: '行为客体', type: '执行器' });
    expect(result.issues.join('')).toContain('跳过 1 条');
  });

  it('accepts Chinese keys and a bare array root', () => {
    const raw = '[{"设备名称":"操作员站 A","设备定位":"行为主体","设备类型":"操作员站","原文依据":"操作员在站内确认"}]';
    const result = parseDevices(raw);
    expect(result.rows[0]).toMatchObject({ name: '操作员站 A', location: '行为主体', type: '操作员站' });
  });

  it('repairs trailing commas and keeps null fields as empty strings', () => {
    const raw = '{"topology":[{"subject":"控制器","object":"给水泵","actionType":"写入","targetParam":null,"targetValue":null,"content":"下发启动指令",}]}';
    const result = parseTopology(raw);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      subject: '控制器',
      actionType: '写',
      targetParam: '',
      targetValue: '',
      operationObject: '',
    });
  });

  it('extracts operation object and value range from Chinese aliases', () => {
    const raw = `{"topology":[{"行为主体":"燃料控制器","行为客体":"燃料执行机构","操作类型":"写","行为内容":"调节燃料量",
      "被操作对象":"燃料指令 fuel_command","值域类型":"连续","操作值域":"0～400 t/h","下限":"0","上限":"400",
      "单位":"t/h","额定值":"157.6","原文依据":"燃料指令允许范围 0～400 t/h"}]}`;
    const result = parseTopology(raw);
    expect(result.rows[0]).toMatchObject({
      operationObject: '燃料指令 fuel_command',
      valueType: '连续',
      valueRange: '0～400 t/h',
      valueMin: '0',
      valueMax: '400',
      valueUnit: 't/h',
      valueNominal: '157.6',
    });
  });

  it('normalizes trigger types and keeps the logic columns', () => {
    const raw = `{"logic":[{"subject":"控制器","subjectType":"控制器","object":"电动阀","objectType":"执行器","actionType":"写",
      "content":"发送开启指令","targetType":"改变行为客体的设定值","targetParam":"阀门开度","targetValue":"开",
      "triggerCause":"压力低于设定值","triggerType":"事件触发","triggerResult":"阀门开启，压力回升","evidence":"压力低于 8.0 MPa 时开启"}]}`;
    const result = parseLogic(raw);
    expect(result.rows[0]).toMatchObject({
      triggerType: '中断式',
      triggerCause: '压力低于设定值',
      targetParam: '阀门开度',
      evidence: '压力低于 8.0 MPa 时开启',
    });
  });

  it('reports truncated output instead of throwing', () => {
    const result = parseLogic('{"logic":[{"subject":"控制器"');
    expect(result.ok).toBe(false);
    expect(result.rows).toHaveLength(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('manual merge and export', () => {
  const base = {
    pageStart: 1,
    pageEnd: 1,
    topology: [],
    logic: [],
    issues: [],
  };
  const segments: ManualSegmentExtraction[] = [
    {
      ...base,
      index: 1,
      devices: [{ name: '给水泵', location: '行为客体', type: '执行器', evidence: '' }],
      logic: [{
        subject: '控制器', subjectType: '控制器', object: '给水泵', objectType: '执行器', actionType: '写',
        content: '启动给水泵', targetType: '改变行为客体的输出', targetParam: '运行状态', targetValue: '运行',
        operationObject: '给水泵运行状态', valueType: '离散', valueRange: '运行/停止',
        valueMin: '', valueMax: '', valueUnit: '', valueNominal: '',
        triggerCause: '流量不足', triggerType: '中断式', triggerResult: '流量恢复', evidence: '',
      }],
    },
    {
      ...base,
      index: 2,
      pageStart: 3,
      pageEnd: 3,
      devices: [{ name: '给水泵', location: '行为客体', type: '执行器', evidence: '' }],
      logic: [{
        subject: '控制器', subjectType: '控制器', object: '给水泵', objectType: '执行器', actionType: '写',
        content: '启动给水泵', targetType: '改变行为客体的输出', targetParam: '运行状态', targetValue: '运行',
        operationObject: '给水泵运行状态', valueType: '离散', valueRange: '运行/停止',
        valueMin: '', valueMax: '', valueUnit: '', valueNominal: '',
        triggerCause: '流量不足', triggerType: '中断式', triggerResult: '流量恢复', evidence: '',
      }],
    },
  ];

  it('dedupes across overlapping segments and records every source', () => {
    const merged = mergeExtractions(segments);
    expect(merged.devices).toHaveLength(1);
    expect(merged.devices[0].sources).toEqual([1, 2]);
    expect(merged.logic).toHaveLength(1);
  });

  it('writes a markdown table with provenance columns', () => {
    const markdown = buildMarkdown({
      schemaVersion: 1,
      source: 'manual.pdf',
      exportedAt: '2026-11-04T00:00:00.000Z',
      model: 'deepseek-chat',
      segments: mergeExtractions(segments).devices.length ? segments : [],
    }, mergeExtractions(segments));
    expect(markdown).toContain('# 操作手册逻辑抽取结果');
    expect(markdown).toContain('| 给水泵 |');
    expect(markdown).toContain('来源分段');
    expect(markdown).toContain('操作对象');
    expect(markdown).toContain('操作值域');
    expect(markdown).toContain('离散 · 运行/停止');
    expect(markdown).toContain('deepseek-chat');
  });

  it('formats value ranges from explicit text or numeric bounds', () => {
    expect(formatValueRangeCell({
      valueType: '连续', valueRange: '', valueMin: '0', valueMax: '400', valueUnit: 't/h', valueNominal: '157.6',
    })).toBe('连续 · 0～400 t/h；额定 157.6');
    expect(formatValueRangeCell({
      valueType: '离散', valueRange: '开/关/自动/手动', valueMin: '', valueMax: '', valueUnit: '', valueNominal: '',
    })).toBe('离散 · 开/关/自动/手动');
    expect(formatValueRangeCell({
      valueType: '', valueRange: '', valueMin: '', valueMax: '', valueUnit: '', valueNominal: '',
    })).toBe('');
  });
});
