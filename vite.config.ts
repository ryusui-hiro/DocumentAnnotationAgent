import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': process.env.ANNOTATION_STUDIO_API_TARGET || 'http://127.0.0.1:3001',
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: process.env.TAURI_ENV_PLATFORM ? {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  } : undefined,
});
