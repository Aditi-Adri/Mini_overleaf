import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // y-monaco imports this exact deep path. monaco-editor's own
      // `exports` map wildcards subpaths as `./esm/vs/<subpath>`, which
      // double-prefixes an already-prefixed specifier like this one,
      // resolving to a file that doesn't exist. Point it straight at the
      // real file instead of fighting the exports map.
      'monaco-editor/esm/vs/editor/editor.api.js': fileURLToPath(
        new URL('./node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url)
      ),
    },
  },
  // This machine's Windows Application Control policy blocks lightningcss's
  // native binary (vite's default CSS minifier) and esbuild isn't installed
  // as a direct dependency under rolldown-vite. The stylesheet here is tiny,
  // so skipping minification costs nothing meaningful.
  build: {
    cssMinify: false,
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:4000',
        changeOrigin: true,
      },
      '/yjs': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:4000',
        ws: true,
      },
      '/presence': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:4000',
        ws: true,
      },
    },
  },
  // `vite preview` serves the production build locally — same proxy rules,
  // so a real `npm run build` can be smoke-tested without Docker/nginx.
  preview: {
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:4000',
        changeOrigin: true,
      },
      '/yjs': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:4000',
        ws: true,
      },
      '/presence': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:4000',
        ws: true,
      },
    },
  },
})
