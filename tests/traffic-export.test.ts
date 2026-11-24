import { describe, expect, it } from 'vitest';
import {
  summarizeQuality,
  variableQuality,
  type TrafficResult,
  type TrafficVariable,
} from '@/domain/traffic';
import {
  buildEvidenceHtml,
  buildReportMarkdown,
  buildResultJson,
  buildVariablesCsv,
} from '@/services/traffic/export';

const result: TrafficResult = {
  plc: '192.168.20.55',
  port: 502,
  session: '0x3E',
  imageBytes: 91676,
  records: 94,
  sha256: 'bf275c692ec3657d434ff7a483f476a5d5382cb030e586255ccab7951fb0017b',
  declarations: false,
  stu: null,
  runDir: 'D:\\data\\traffic\\20261118-190255_192.168.20.55',
  units: [
    {
      index: 1,
      name: 'FB_FuelController',
      kind: '功能块',
      chars: 845,
      status: '解析成功',
      declared: true,
      streamOffset: '0x064FA',
      text: 'IF A < B THEN\n    Y := 1.0;\nEND_IF;',
    },
  ],
};

const variables: TrafficVariable[] = [
  {
    unit: 'FB_FuelController',
    name: 'Deviation',
    type: 'REAL',
    category: '内部',
    range: '比较常量 43.0',
    basis: '源码比较常量：Deviation > 43.0;',
    inferred: true,
  },
  {
    unit: 'FB_FuelController',
    name: 'Mystery',
    type: '未知',
    category: '未知',
    range: '未定',
    basis: '无法从源码推断',
  },
];

describe('traffic quality scoring', () => {
  it('scores a well-evidenced variable higher than an undetermined one', () => {
    expect(variableQuality(variables[0])).toEqual({ score: 90, level: '高' });
    expect(variableQuality(variables[1])).toEqual({ score: 20, level: '低' });
  });

  it('summarizes counts and averages', () => {
    expect(summarizeQuality(variables)).toEqual({
      total: 2,
      average: 55,
      high: 1,
      mid: 0,
      low: 1,
      withRange: 1,
    });
  });

  it('uses an explicit quality score when provided', () => {
    expect(variableQuality({ ...variables[0], quality: 74 })).toEqual({ score: 74, level: '中' });
  });
});

describe('traffic exports', () => {
  it('writes a UTF-8 BOM CSV with quality columns', () => {
    const csv = buildVariablesCsv(variables);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('所属单元,变量名,类型,类别,值域范围 / 相关常量,依据,质量分,质量等级');
    expect(csv).toContain('Deviation');
    expect(csv).toContain('90,高');
    expect(csv).toContain('20,低');
  });

  it('writes a markdown report with units, variables and source', () => {
    const markdown = buildReportMarkdown(result, variables, '2026-11-18 19:10:00');
    expect(markdown).toContain('# 控制程序解析报告');
    expect(markdown).toContain(result.sha256);
    expect(markdown).toContain('FB_FuelController');
    expect(markdown).toContain('Deviation');
    expect(markdown).toContain('90 · 高');
    expect(markdown).toContain('```st');
  });

  it('escapes source text in the standalone evidence page', () => {
    const page = buildEvidenceHtml(result, variables, '2026-11-18 19:10:00');
    expect(page).toContain('<!doctype html>');
    expect(page).toContain(result.sha256);
    expect(page).toContain('&lt;');
    expect(page).toContain('验收证据');
    expect(page).toContain('90 · 高');
  });

  it('includes quality scores in the JSON export', () => {
    const payload = JSON.parse(buildResultJson(result, variables, '2026-11-18 19:10:00')) as {
      variables: Array<{ name: string; quality: { score: number; level: string } }>;
    };
    expect(payload.variables[0]).toMatchObject({
      name: 'Deviation',
      quality: { score: 90, level: '高' },
    });
  });
});
