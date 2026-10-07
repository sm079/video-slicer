import { defineConfig } from 'vite';

export default defineConfig({
  // mediabunny alone is ~700 kB; it is needed up front.
  build: { target: 'es2022', chunkSizeWarningLimit: 1024 },
  optimizeDeps: { exclude: ['web-demuxer'] },
});
