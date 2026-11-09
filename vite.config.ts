import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';
import { manualExtractMiddleware } from './server/manual-extract.ts';

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
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
