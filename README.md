# Gerty

#### A browser-based, open source, free to use video editor.

- No login, no personalised tracking, no ads, no scraping your data, no AI, no bullshit.
- Code is fully open source
- Import images, video clips, audio clips
- Add custom arrows, shapes, text, all with animated effects, keyframing
- Add video-wide effects, like a camera zoom, sepia, vignette, film grain, etc.
- Preview the video in real time. Export to MP4, with customisable quality/size

### "What it lacks in features, it makes up for in not being dogshit" - me

## https://gerty.tomg.cool/ 👈 use it right now

https://github.com/user-attachments/assets/b078db2a-b289-4c58-b6ba-dfc386c7d952

---

## What you can do

- **Bring in your media** - drop in images, video clips and audio. Everything stays on your machine; nothing is uploaded.
- **Build on a timeline** - stack clips on layers, move and group them, trim their ends, and split a clip in two at the playhead.
- **Annotate** - arrows, text boxes, rectangles, circles and freehand pen, all fully stylable.
- **Animate anything** - keyframe an object's position, size, rotation and opacity; add on-appear / on-exit transitions; give text a type-on reveal and arrows a draw-on.
- **Add a camera** - screen-recorder-style zoom and pan push-ins that glide across the frame, with their own keyframes.
- **Grade and stylise** - a deep effects menu: black & white, sepia, vignette, film grain, old film, hue shift, contrast, bleach bypass, light leaks, chromatic split, plus GPU shader looks like gradient maps, duotone, CRT, VHS, halftone and comic ink.
- **One-click presets** - drop a whole graded look on a clip: **Cinematic** (teal & orange), **Cinematic Cool**, **Super 8**, **Retro TV**, **Film Noir**, **Comic Book** and more. Every preset is just a starting point you can tweak.
- **Mark the beat** - tap `M` while it plays to drop markers, then snap edits to them.
- **Preview live, then export** - real-time preview, then export to **MP4** (H.264 + AAC) at a resolution and quality you choose, with a file-size estimate before you commit.
- **Save your work** - export a project to a `.gerty` file and re-import it later to pick up where you left off.

## Keyboard shortcuts

| Key                   | Action                                              |
| --------------------- | --------------------------------------------------- |
| Space                 | Play / pause                                        |
| V                     | Toggle camera **Live** / **Frame** view             |
| M                     | Drop a marker at the playhead (works while playing) |
| , / .                 | Jump to previous / next marker                      |
| S                     | Split the selected audio/video clip at the playhead |
| H                     | Hide / show the selected object or zoom             |
| Delete / Backspace    | Delete the selection                                |
| Ctrl+Z                | Undo                                                |
| Ctrl+Y / Ctrl+Shift+Z | Redo                                                |
| Enter / Escape        | Finish the current drawing / deselect               |

## Privacy

There is no backend. Your media never leaves the browser - imported files live in your browser's own storage (IndexedDB) and rendering, editing and export all happen locally on your device.

---

## Running it locally

```bash
npm install
npm run dev
```

Then open the printed local URL. To make a production build:

```bash
npm run build    # type-check + bundle to dist/
npm run preview  # serve the production build locally
```

### Tech stack

- **React 19 + TypeScript**, bundled with **Vite**
- **Tailwind CSS v4** for styling
- **Canvas 2D** for the shared preview/export compositor, with a **WebGL** ([regl](https://github.com/regl-project/regl)) post-process pass for per-pixel shader effects
- **WebCodecs + [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)** for in-browser MP4 export (with a MediaRecorder → WebM fallback on browsers without WebCodecs)

A single pure `renderFrame` compositor drives both the live preview and export, so what you see is what you get. For a full architecture tour, see [`CLAUDE.md`](CLAUDE.md).

## License

Licensed under the [GNU General Public License v3.0](LICENSE). You are free to use, study, share and modify this software; if you distribute a modified version, it must also be free software under the same license.
