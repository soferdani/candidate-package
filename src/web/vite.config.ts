import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the backend on :3000 so the frontend uses same-origin
// relative URLs (no CORS quirks, no hardcoded host). The backend already enables CORS,
// but proxying keeps the client code identical between dev and a static prod build.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
