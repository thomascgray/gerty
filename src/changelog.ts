// ─────────────────────────────────────────────────────────────────────────────
// CHANGELOG - edit me!
//
// This is the list shown by the "What's new" button in the top-right of the app.
// To add a release, drop a new entry at the TOP of the array below (newest first):
//
//   { version: 'v1.2', date: 'Aug 2026', items: [
//     'Short, user-facing bullet - describe a thing the user can now do.',
//     'Another one.',
//   ] },
//
// Keep bullets short and focused on "things the user can do" (and notable fixes).
// `date` is optional. That's the whole format.
// ─────────────────────────────────────────────────────────────────────────────

export type ChangelogEntry = {
  version: string
  date?: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: 'v1.2.2',
    date: 'Aug 2026',
    items: [
      'Stack effects - layer more than one at a time and reorder them, everywhere effects live.',
      'Objects and text can carry several motions/effects at once (e.g. shake and bob together, or outline + wave + a colour fill on text).',
      'Full screen effects are now one item on the left rail: add a “Full screen effect”, then stack CRT, halftone, grain and more inside a single timeline bar that fades in and out together.',
      'Presets now drop as one stacked full-screen effect you can tweak layer by layer, hide individual layers, and reorder.',
      'Old projects load unchanged - any existing effect just becomes the first layer of its stack.',
    ],
  },
  {
    version: 'v1.2.1',
    date: 'Aug 2026',
    items: [
      'Auto captions - generate subtitles from your timeline’s speech with one click, in Media → Auto captions.',
      'It transcribes everything that’s spoken (a video’s own audio, audio clips, and text-to-speech narration all at once) and lays the captions out on their own timeline row.',
      'Captions play on the canvas as you scrub and are burned into your exported video, styled to match (size, colour, position, and an optional background).',
      'Fix anything the recognition got wrong: edit a caption’s text, drag its timing with start/end fields, add new captions, or delete them from the properties panel.',
      'Got music or singing in the mix? Mark any clip “Skip captions” so it’s left out of the transcription and doesn’t confuse the results.',
      'Runs entirely on your device - the audio never leaves your machine (the speech model downloads once, then it’s cached), with a live progress bar while it works.',
    ],
  },
  {
    version: 'v1.2',
    date: 'Aug 2026',
    items: [
      'Text to speech - type a script, pick a voice, and generate voice-over narration straight onto the timeline.',
      'Choose from eight voices, preview the result before committing, and regenerate any narration clip later to tweak the script or voice.',
      'Speech is synthesized entirely on your device - your script and the audio never leave your machine (the voice model downloads once, then it’s cached).',
      'Much smaller exports: video is now encoded against your source’s own bitrate, so re-exported screen recordings come out a fraction of the size at the same quality.',
    ],
  },
  {
    version: 'v1.1',
    items: [
      'Drop files anywhere in the window to import them - not just through the import dialog.',
      'New toast notifications, e.g. when you drop a file type that can’t be imported.',
      'Shift + scroll to pan the timeline sideways through time (all scroll shortcuts are now listed in the keyboard-shortcuts panel).',
      'Timeline bars and lanes shrink when you zoom far out, so more of your project fits on screen.',
      'Smooth open/close animations for the timeline and the asset panel.',
      'Add a marker at the playhead at any time (tap to the beat while playing).',
      'Convert a video clip to audio-only.',
      'Download individual clips back to your computer with their trims and edits baked in.',
      'Refreshed effect icons and fixed the timeline expand button so it no longer jumps around when collapsed.',
    ],
  },
  {
    version: 'v1',
    items: [
      'Runs entirely in your browser - no uploads, no account, nothing leaves your machine.',
      'Import photos, video, audio, and animated GIFs by drag-and-drop, file picker, or URL.',
      'Layer everything on a multi-lane timeline with drag-to-reorder z-order.',
      'Add text, arrows, rectangles, circles, and freehand annotations.',
      'Trim, split, and re-speed audio and video clips; adjust volume and mute.',
      'Animate anything with keyframes - move, scale, rotate, and fade with easing.',
      'On-appear / on-exit transitions (fade, slide, pop) and type-on / draw-on reveals.',
      'Camera zooms - screen-recorder-style push-ins that can pan and scale between poses.',
      'A library of video effects across colour grades, overlays, and GPU-powered looks - plus one-click presets.',
      'Markers, snapping, and a full set of keyboard shortcuts.',
      'Choose your aspect ratio / canvas size, and switch between light and dark themes.',
      'Undo / redo up to 50 steps.',
      'Save and reload projects, and export finished videos to MP4 with quality settings.',
    ],
  },
]
