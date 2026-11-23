import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';
import { manualExtractMiddleware } from './server/manual-extract.ts';
import { manualRunsMiddleware } from './server/manual-runs.ts';
import { trafficMiddleware } from './server/traffic.ts';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'manual-extract-api',
      configureServer(server) {
        // 开发服务器内直接挂载 Node 中间件，避免再起一个后端进程或做代理。
        server.middlewares.use('/api/manual/extract', (req, res, next) => {
          void manualExtractMiddleware(req, res, next);
        });
        server.middlewares.use('/api/manual/runs', (req, res, next) => {
          void manualRunsMiddleware(req, res, next);
        });
        server.middlewares.use('/api/traffic', (req, res, next) => {
          void trafficMiddleware(req, res, next);
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: 'localhost',
    port: 5174,
    strictPort: true,
    watch: {
      // 运行产物由服务端写入，Vite 监听会短暂占用目录，导致 Windows 重命名失败。
      ignored: ['**/data/**'],
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
