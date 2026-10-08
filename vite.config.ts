import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works under the GitHub Pages subpath.
  base: './',
  // mediabunny alone is ~700 kB; it is needed up front.
  build: { target: 'es2022', chunkSizeWarningLimit: 1024 },
  optimizeDeps: { exclude: ['web-demuxer'] },
});
