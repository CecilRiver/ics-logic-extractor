import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const python = process.env.PYTHON_BIN || 'python';
const runner = fileURLToPath(new URL('../python/plc_runner.py', import.meta.url));

const pythonOk = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0;
const suite = pythonOk ? describe : describe.skip;

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  const result = spawnSync(python, [runner, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  const events = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...result, events };
}

const SAMPLE = `FUNCTION_BLOCK FB_Sample
VAR_INPUT
    Ts : REAL := 0.1;
    Startup : BOOL;
END_VAR
VAR_OUTPUT
    Alarm : BOOL;
END_VAR
VAR
    Deviation : REAL;
    Err0 : REAL;
    Counter : INT;
    Last : REAL;
END_VAR

IF Startup THEN
    Err0 := 0.0;
    Counter := 0;
END_IF;

Deviation := ABS(Ts - 0.1);
Alarm := Deviation > 43.0;
Last := Deviation;
END_FUNCTION_BLOCK
`;

suite('traffic variable extraction', () => {
  it('infers ranges from constants, initial values and data types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traffic-vars-'));
    cleanup.push(dir);
    mkdirSync(join(dir, '02_逆向'), { recursive: true });
    writeFileSync(join(dir, '02_逆向', 'st_01_0x00001.st'), SAMPLE, 'utf8');

    const result = run(['variables', '--run-dir', dir]);
    expect(result.status).toBe(0);

    const output = result.events.find((event) => event.type === 'result');
    expect(output).toBeTruthy();
    const rows = output?.variables as Record<string, string>[];
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get('Ts')).toMatchObject({ category: '输入', range: '初值 0.1' });
    expect(byName.get('Startup')).toMatchObject({ category: '输入', range: '0 / 1' });
    expect(byName.get('Alarm')).toMatchObject({ category: '输出', range: '0 / 1' });
    expect(byName.get('Deviation')).toMatchObject({ category: '内部', range: '比较常量 43.0' });
    expect(byName.get('Err0')?.range).toBe('赋值常量 0.0');
    expect(byName.get('Counter')?.range).toBe('赋值常量 0');
    expect(byName.get('Last')?.range).toBe('±3.402823E38');
    expect(byName.get('Deviation')?.basis).toContain('Deviation > 43.0');

    // 变量表写盘，便于事后核对
    const saved = readdirSync(join(dir, '03_变量'));
    expect(saved).toContain('变量表.json');
  });

  it('fails cleanly when the PLC is unreachable and leaves no run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'traffic-fetch-'));
    cleanup.push(root);

    const result = run([
      'fetch',
      '--ip', '127.0.0.1',
      '--port', '1',
      '--timeout', '1',
      '--out-root', root,
    ]);

    expect(result.status).toBe(1);
    const error = result.events.find((event) => event.type === 'error');
    expect(String(error?.message ?? '')).toMatch(/127\.0\.0\.1:1/);
    expect(String(error?.message ?? '')).toMatch(/超时|无法连接/);
    expect(readdirSync(root).filter((name) => !name.startsWith('.'))).toHaveLength(0);
  });
});
