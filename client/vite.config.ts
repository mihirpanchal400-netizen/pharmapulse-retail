import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs as a separate process on :4000. Proxying /api keeps the
    // client's fetch calls same-origin, so there are no CORS surprises and the
    // same relative URLs work in a production build.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
