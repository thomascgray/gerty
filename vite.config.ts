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
  // Pre-bundle the lazily-imported ML engines at server startup, so Vite doesn't discover them only
  // on first Generate and do a full page reload ("new dependencies optimized") — which closes the
  // modal mid-gesture. `onnxruntime-web` = TTS (spec 32); `@huggingface/transformers` = auto-captions
  // Whisper (spec 35), both imported lazily inside their workers.
  optimizeDeps: {
    include: ['onnxruntime-web', '@huggingface/transformers'],
  },
})
