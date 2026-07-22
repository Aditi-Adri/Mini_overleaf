import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
    },
  },
})
