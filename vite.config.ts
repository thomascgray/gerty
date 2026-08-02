import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  // Pre-bundle onnxruntime-web at server startup (spec 32 TTS). It's imported lazily inside
  // tts.worker.ts, so without this Vite discovers it only on first Generate and does a full page
  // reload ("new dependencies optimized") — which closes the TTS modal mid-gesture.
  optimizeDeps: {
    include: ['onnxruntime-web'],
  },
})
