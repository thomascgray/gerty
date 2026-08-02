/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Override the pocket-tts model-weights base URL (spec 32). Unset ⇒ local `/models/...` in dev,
  // the HuggingFace mirror in production. Point this at your own HF repo / R2 bucket to self-host.
  readonly VITE_TTS_MODEL_BASE?: string
}
