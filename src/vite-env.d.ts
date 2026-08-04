/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Override the pocket-tts model-weights base URL (spec 32). Unset ⇒ local `/models/...` in dev,
  // the HuggingFace mirror in production. Point this at your own HF repo / R2 bucket to self-host.
  readonly VITE_TTS_MODEL_BASE?: string
  // Override the Whisper caption-weights host (spec 35). Unset ⇒ same-origin `/models/` in dev, the
  // R2 bucket in production. transformers.js appends `{model}/{revision}/<file>` to this (see
  // src/lib/captions.worker.ts MODEL_PATH_TEMPLATE). Trailing slash required.
  readonly VITE_CAPTIONS_MODEL_HOST?: string
}
