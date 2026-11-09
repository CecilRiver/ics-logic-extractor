import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 极简 .env 加载器：只补齐尚未设置的变量，不覆盖真实环境变量。
 * 使用它而不是依赖启动参数，保证 `pnpm dev`、`pnpm start` 与 Vite 配置加载行为一致。
 */
export function loadEnv(root = process.cwd()): void {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
