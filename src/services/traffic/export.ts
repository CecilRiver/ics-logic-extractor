import {
  summarizeQuality,
  variableQuality,
  type TrafficResult,
  type TrafficVariable,
} from '@/domain/traffic';

const BOM = '﻿';

function fileBase(result: TrafficResult): string {
  const runName = result.runDir.split(/[\\/]/).pop() || 'traffic';
  return `${result.plc || 'plc'}_${runName}`.replace(/[\\/:*?"<>|]/g, '_');
}

function generatedStamp(value?: string): string {
  return value ?? new Date().toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function csvCell(value: string): string {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function mdCell(value: string): string {
  return (value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return '（无）\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`),
    '',
  ].join('\n');
}

function html(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildVariablesCsv(variables: TrafficVariable[]): string {
  const rows: string[][] = [
    ['所属单元', '变量名', '类型', '类别', '值域范围 / 相关常量', '依据', '质量分', '质量等级'],
    ...variables.map((row) => {
      const quality = variableQuality(row);
      return [
        row.unit,
        row.name,
        row.type,
        row.category,
        row.range,
        row.basis,
        String(quality.score),
        quality.level,
      ];
    }),
  ];
  return BOM + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function buildVariablesMarkdown(result: TrafficResult, variables: TrafficVariable[], generatedAt?: string): string {
  return [
    '# 关键变量与值域',
    '',
    `- PLC：${result.plc}:${result.port}`,
    `- 运行目录：${result.runDir}`,
    `- 生成时间：${generatedStamp(generatedAt)}`,
    '',
    mdTable(
      ['所属单元', '变量名', '类型', '类别', '值域范围 / 相关常量', '依据', '质量'],
      variables.map((row) => {
        const quality = variableQuality(row);
        return [row.unit, row.name, row.type, row.category, row.range, row.basis, `${quality.score} · ${quality.level}`];
      }),
    ),
  ].join('\n');
}

export function buildReportMarkdown(
  result: TrafficResult,
  variables: TrafficVariable[] | null,
  generatedAt?: string,
): string {
  const quality = variables ? summarizeQuality(variables) : null;
  const lines = [
    '# 控制程序解析报告',
    '',
    '## 运行信息',
    '',
    `- PLC：${result.plc}:${result.port}`,
    `- 运行目录：${result.runDir}`,
    `- 生成时间：${generatedStamp(generatedAt)}`,
    `- 工程大小：${formatBytes(result.imageBytes)}（${result.imageBytes} 字节）`,
    `- 记录数：${result.records}`,
    `- 会话号：${result.session || '—'}`,
    `- SHA-256：${result.sha256 || '—'}`,
    `- 程序单元：${result.units.length}`,
    `- 变量数：${variables?.length ?? 0}`,
  ];
  if (quality) {
    lines.push(
      `- 质量：平均 ${quality.average}（高 ${quality.high} / 中 ${quality.mid} / 低 ${quality.low}），`
      + `有值域 ${quality.withRange} / ${quality.total}`,
    );
  }

  lines.push(
    '',
    '## 程序单元',
    '',
    mdTable(
      ['序号', '名称', '类型', '字符数', '解析状态'],
      result.units.map((unit) => [
        String(unit.index),
        unit.name,
        unit.kind,
        String(unit.chars),
        unit.status,
      ]),
    ),
    '## 关键变量与值域',
    '',
    variables?.length
      ? mdTable(
          ['所属单元', '变量名', '类型', '类别', '值域范围 / 相关常量', '依据', '质量'],
          variables.map((row) => {
            const q = variableQuality(row);
            return [row.unit, row.name, row.type, row.category, row.range, row.basis, `${q.score} · ${q.level}`];
          }),
        )
      : '（未提取变量）\n',
    '## 程序源码',
    '',
  );

  for (const unit of result.units) {
    lines.push(`### ${unit.name}（${unit.kind}，${unit.chars} 字符）`, '', '```st', unit.text.trim(), '```', '');
  }
  return lines.join('\n');
}

export function buildEvidenceHtml(
  result: TrafficResult,
  variables: TrafficVariable[] | null,
  generatedAt?: string,
): string {
  const quality = variables ? summarizeQuality(variables) : null;
  const info: Array<[string, string]> = [
    ['PLC', `${result.plc}:${result.port}`],
    ['运行目录', result.runDir],
    ['生成时间', generatedStamp(generatedAt)],
    ['工程大小', `${formatBytes(result.imageBytes)}（${result.imageBytes} 字节）`],
    ['记录数', String(result.records)],
    ['会话号', result.session || '—'],
    ['SHA-256', result.sha256 || '—'],
    ['程序单元', String(result.units.length)],
    ['变量数', String(variables?.length ?? 0)],
  ];
  if (quality) {
    info.push(['质量概览', `平均 ${quality.average}；高 ${quality.high} / 中 ${quality.mid} / 低 ${quality.low}；有值域 ${quality.withRange} / ${quality.total}`]);
  }

  const units = result.units.map((unit) => `
    <tr>
      <td class="num">${unit.index}</td>
      <td><b>${html(unit.name)}</b></td>
      <td>${html(unit.kind)}</td>
      <td class="num">${unit.chars}</td>
      <td><span class="ok">${html(unit.status)}</span></td>
    </tr>`).join('');

  const variablesHtml = variables?.length
    ? variables.map((row) => {
        const q = variableQuality(row);
        return `
    <tr>
      <td>${html(row.unit)}</td>
      <td><b>${html(row.name)}</b></td>
      <td>${html(row.type)}</td>
      <td>${html(row.category)}</td>
      <td>${html(row.range)}</td>
      <td class="basis">${html(row.basis)}</td>
      <td><span class="q ${q.level === '高' ? 'high' : q.level === '中' ? 'mid' : 'low'}">${q.score} · ${q.level}</span></td>
    </tr>`;
      }).join('')
    : '<tr><td colspan="7" class="empty">未提取变量</td></tr>';

  const sources = result.units.map((unit) => `
    <details open>
      <summary>${html(unit.name)}（${html(unit.kind)}，${unit.chars} 字符）</summary>
      <pre>${html(unit.text)}</pre>
    </details>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>控制程序解析验收证据</title>
<style>
  body { margin: 32px auto; max-width: 1180px; padding: 0 20px; color: #22364b; font: 13px/1.6 "Microsoft YaHei", "PingFang SC", sans-serif; }
  h1 { margin: 0 0 6px; font-size: 24px; }
  h2 { margin: 28px 0 10px; font-size: 17px; border-bottom: 1px solid #dfe6ef; padding-bottom: 6px; }
  .meta { color: #7d8b9c; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 7px 9px; text-align: left; vertical-align: top; border: 1px solid #e3e9f1; }
  th { background: #f4f8fc; font-weight: 600; }
  tr:nth-child(even) td { background: #fbfcfe; }
  td.num { text-align: right; font-family: Consolas, monospace; white-space: nowrap; }
  td.basis { color: #5c6c80; font-size: 12px; }
  .ok { color: #2f6b4b; background: #edf7f1; border: 1px solid #cfe7da; border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
  .q { border-radius: 999px; padding: 1px 8px; font-weight: 600; white-space: nowrap; }
  .q.high { color: #2f6b4b; background: #edf7f1; }
  .q.mid { color: #82601f; background: #fdf6e7; }
  .q.low { color: #923f37; background: #fcf0ee; }
  .empty { color: #7d8b9c; text-align: center; }
  pre { margin: 8px 0 0; padding: 12px; overflow: auto; background: #f6f8fb; border: 1px solid #e3eaf3; font: 12px/1.55 Consolas, monospace; white-space: pre; }
  details { margin: 8px 0; border: 1px solid #e3e9f1; border-radius: 8px; padding: 8px 10px; }
  summary { cursor: pointer; font-weight: 600; }
  @media print { body { margin: 0; } details { break-inside: avoid; } details > pre { display: block; } }
</style>
</head>
<body>
  <h1>控制程序解析验收证据</h1>
  <div class="meta">由业务逻辑提取工具生成 · ${html(generatedStamp(generatedAt))}</div>

  <h2>运行信息</h2>
  <table>
    <tbody>${info.map(([key, value]) => `<tr><th style="width:150px">${html(key)}</th><td>${html(value)}</td></tr>`).join('')}</tbody>
  </table>

  <h2>程序单元</h2>
  <table>
    <thead><tr><th>序号</th><th>名称</th><th>类型</th><th>字符数</th><th>解析状态</th></tr></thead>
    <tbody>${units || '<tr><td colspan="5" class="empty">没有程序单元</td></tr>'}</tbody>
  </table>

  <h2>关键变量与值域</h2>
  <table>
    <thead><tr><th>所属单元</th><th>变量名</th><th>类型</th><th>类别</th><th>值域范围 / 相关常量</th><th>依据</th><th>质量</th></tr></thead>
    <tbody>${variablesHtml}</tbody>
  </table>

  <h2>程序源码</h2>
  ${sources || '<p class="meta">没有程序源码。</p>'}
</body>
</html>`;
}

export function buildResultJson(
  result: TrafficResult,
  variables: TrafficVariable[] | null,
  generatedAt?: string,
): string {
  return JSON.stringify(
    {
      generatedAt: generatedStamp(generatedAt),
      result,
      variables: variables?.map((row) => ({ ...row, quality: variableQuality(row) })) ?? null,
    },
    null,
    2,
  );
}

export function exportVariablesCsv(result: TrafficResult, variables: TrafficVariable[]): void {
  downloadText(`${fileBase(result)}_变量表.csv`, buildVariablesCsv(variables), 'text/csv;charset=utf-8');
}

export function exportVariablesMarkdown(result: TrafficResult, variables: TrafficVariable[]): void {
  downloadText(
    `${fileBase(result)}_变量表.md`,
    buildVariablesMarkdown(result, variables),
    'text/markdown;charset=utf-8',
  );
}

export function exportReportMarkdown(result: TrafficResult, variables: TrafficVariable[] | null): void {
  downloadText(
    `${fileBase(result)}_解析报告.md`,
    buildReportMarkdown(result, variables),
    'text/markdown;charset=utf-8',
  );
}

export function exportEvidenceHtml(result: TrafficResult, variables: TrafficVariable[] | null): void {
  downloadText(
    `${fileBase(result)}_验收证据.html`,
    buildEvidenceHtml(result, variables),
    'text/html;charset=utf-8',
  );
}

export function exportResultJson(result: TrafficResult, variables: TrafficVariable[] | null): void {
  downloadText(
    `${fileBase(result)}_解析结果.json`,
    buildResultJson(result, variables),
    'application/json;charset=utf-8',
  );
}

export async function exportExcel(result: TrafficResult, variables: TrafficVariable[] | null): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');

  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  const infoRows = [
    [bold('字段'), bold('值')],
    ['PLC', `${result.plc}:${result.port}`],
    ['运行目录', result.runDir],
    ['工程大小', `${formatBytes(result.imageBytes)}（${result.imageBytes} 字节）`],
    ['记录数', String(result.records)],
    ['会话号', result.session || '—'],
    ['SHA-256', result.sha256 || '—'],
    ['程序单元', String(result.units.length)],
    ['变量数', String(variables?.length ?? 0)],
  ];

  const unitRows = [
    ['序号', '名称', '类型', '字符数', '解析状态'].map(bold),
    ...result.units.map((unit) => [
      unit.index,
      unit.name,
      unit.kind,
      unit.chars,
      unit.status,
    ]),
  ];

  const variableRows = [
    ['所属单元', '变量名', '类型', '类别', '值域范围 / 相关常量', '依据', '质量分', '质量等级'].map(bold),
    ...(variables ?? []).map((row) => {
      const quality = variableQuality(row);
      return [
        row.unit,
        row.name,
        row.type,
        row.category,
        row.range,
        row.basis,
        quality.score,
        quality.level,
      ];
    }),
  ];

  const sourceRows = [
    ['单元', '源码'].map(bold),
    ...result.units.map((unit) => [unit.name, unit.text.slice(0, 32000)]),
  ];

  await writeXlsxFile(
    [
      { sheet: '运行信息', data: infoRows, columns: [{ width: 20 }, { width: 90 }], showGridLines: false },
      { sheet: '程序单元', data: unitRows, columns: [{ width: 8 }, { width: 30 }, { width: 12 }, { width: 10 }, { width: 14 }] },
      { sheet: '关键变量', data: variableRows, columns: [{ width: 18 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 30 }, { width: 60 }, { width: 10 }, { width: 10 }] },
      { sheet: '程序源码', data: sourceRows, columns: [{ width: 26 }, { width: 110 }] },
    ],
    { fontFamily: 'Microsoft YaHei', fontSize: 11 },
  ).toFile(`${fileBase(result)}_控制程序解析.xlsx`);
}
