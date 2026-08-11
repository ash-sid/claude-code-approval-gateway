import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4517';

// In dev, proxy the API + SSE stream to the gateway server so the dashboard
// can be served by Vite on :5173 while talking to the gateway on :4517.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: true },
      '/pre-tool-use': { target: GATEWAY, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
