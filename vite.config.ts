import { defineConfig } from 'vite';

export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:8787' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
