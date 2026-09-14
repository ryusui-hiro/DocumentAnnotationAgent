import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

function pdfBrowserAssets(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'pdf-browser-assets',
    configResolved(value) { config = value; },
    async closeBundle() {
      const destination = resolve(config.root, config.build.outDir, 'pdfjs');
      await mkdir(destination, { recursive: true });
      for (const name of ['cmaps', 'standard_fonts', 'wasm']) await cp(resolve(config.root, 'node_modules/pdfjs-dist', name), resolve(destination, name), { recursive: true });
    },
  };
}
export default defineConfig(({ mode }) => ({
  plugins: [react(), pdfBrowserAssets()],
  base: mode === 'pages' ? '/DocumentAnnotationAgent/' : '/',
  define: { 'import.meta.env.VITE_STATIC_BUILD': JSON.stringify(mode === 'pages' ? 'true' : 'false') },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': process.env.ANNOTATION_STUDIO_API_TARGET || 'http://127.0.0.1:3001' },
    watch: { ignored: ['**/src-tauri/**', '**/.cache/**'] },
  },
  build: {
    outDir: mode === 'pages' ? 'dist-pages' : 'dist',
    ...(process.env.TAURI_ENV_PLATFORM ? {
      target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
      minify: !process.env.TAURI_ENV_DEBUG, sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    } : {}),
  },
}));
