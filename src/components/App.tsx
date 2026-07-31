import { useState, useCallback, useEffect, useRef } from 'react'
import type { InteractionMode, TimelineObjectType, TimelineObject, ArrowData, FreehandData, VideoEffectKind, PhotoData } from '../types'
import { createTimelineObject, createCameraZoom, createVideoEffect, createMarker } from '../types'
import { getRememberedStyle, getRememberedData } from '../lib/objectDefaults'
import { EFFECT_PRESETS, buildPresetEffects } from '../lib/effectPresets'
import { useProject } from '../hooks/useProject'
import { usePlayback } from '../hooks/usePlayback'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useUiPrefs } from '../hooks/useUiPrefs'
import { loadAssetsFromDB, clearAllAssets, getAssetBlob, generateWaveform, isSupportedMediaFile } from '../lib/assetStore'
import { exportProjectBrep, importProjectBrep } from '../lib/projectStorage'
import { downloadOriginal, downloadProcessed } from '../lib/objectDownload'
import { pushToast, dismissToast } from '../hooks/useToasts'
import { config } from '../config'
import Canvas from './Canvas'
import Toasts from './Toasts'
import LeftRail from './LeftRail'
import AspectRatioSelector from './AspectRatioSelector'
import TransportBar from './TransportBar'
import Timeline from './Timeline'
import PropertiesPanel from './PropertiesPanel'
import ImportModal from './ImportModal'
import ExportModal from './ExportModal'
import AppearanceControls from './AppearanceControls'
import HotkeysModal from './HotkeysModal'
import ChangelogModal from './ChangelogModal'
import {
  IconDeviceFloppy, IconFolderOpen, IconArrowBackUp, IconArrowForwardUp,
  IconDownload, IconChevronUp, IconKeyboard, IconCoffee, IconHistory,
} from '@tabler/icons-react'

// Timeline resize/collapse (spec 16 B). Ephemeral view state — not persisted, not part of undo.
const HEADER_HEIGHT = 48 // top bar (h-12)
const MIN_TIMELINE_HEIGHT = 140 // ruler + Camera track + ~1 lane + add-lane rows stay usable
const MIN_RENDER_HEIGHT = 200 // never let the timeline starve the render below this
const COLLAPSED_TIMELINE_HEIGHT = 32
const SPLITTER_HEIGHT = 6 // the resize handle (h-1.5); part of the animated timeline-area height

const maxTimelineHeight = () =>
  Math.max(MIN_TIMELINE_HEIGHT, window.innerHeight - HEADER_HEIGHT - MIN_RENDER_HEIGHT)
const clampTimelineHeight = (h: number) =>
  Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxTimelineHeight(), h))
const defaultTimelineHeight = () => clampTimelineHeight(Math.round(window.innerHeight * 0.26))

export default function App() {
  const { project, dispatch, canUndo, canRedo, undo, redo, isDirty, markSaved } = useProject()
  const playback = usePlayback(project)
  const uiPrefs = useUiPrefs()

  // On startup: when persisting, restore asset blobs from IndexedDB; otherwise purge them. Without
  // this, assets accumulate across sessions (projects reset with persistProject=false, but the
  // IndexedDB blobs don't) and inflate getTotalAssetSize() past the 500 MB warning even for a tiny
  // fresh import. Purging keeps the size total (and the rail's library) scoped to the current session.
  useEffect(() => {
    if (config.persistProject) loadAssetsFromDB()
    else clearAllAssets()
  }, [])

  // Reflect the project name in the browser tab.
  useEffect(() => {
    const name = project.name.trim()
    document.title = name ? `${name} - Gerty` : 'Gerty'
  }, [project.name])

  // Audio/video playback sync — preview speed keeps media in step with the sped-up playhead.
  const { isMuted, toggleMute, volume, setVolume } = useAudioPlayback(project.objects, playback.globalTime, playback.isPlaying, playback.playbackSpeed)

  // Per-object drawing state (spec 17 M): non-null = actively drawing/editing that arrow/freehand's
  // points. Replaces the old global Move/Draw toggle; interactionMode is DERIVED from it below.
  const [drawingObjectId, setDrawingObjectId] = useState<string | null>(null)
  // Multi-select: `selectedObjectIds` is the source of truth — a set of selected object ids that may
  // span lanes (shift-click to add/remove). `selectedObjectId` is the single "primary" selection that
  // drives the properties panel + canvas overlay; it's non-null only when EXACTLY one object is
  // selected, so a multi-selection intentionally shows no panel and no canvas box (it's a timeline
  // bulk-move tool). Zoom/effect selection stay mutually exclusive with any object selection.
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([])
  const selectedObjectId = selectedObjectIds.length === 1 ? selectedObjectIds[0] : null
  const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null)
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null)
  // Camera view (spec 13): 'frame' = author un-zoomed with a framing rectangle; 'live' = apply the
  // real transform (WYSIWYG, matches export). Pure view state — not persisted, not part of undo.
  const [cameraView, setCameraView] = useState<'frame' | 'live'>('frame')
  const [showImport, setShowImport] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showHotkeys, setShowHotkeys] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const projectFileRef = useRef<HTMLInputElement>(null)

  // Drag-and-drop import (spec 31 B). A window-level drop opens ImportModal pre-staged. `dropFiles`
  // is handed to the modal (fresh array each drop → append when already open, B9). `isFileDragging`
  // drives the drop overlay; the depth counter keeps it flicker-free across child dragenter/leave (B3).
  const [isFileDragging, setIsFileDragging] = useState(false)
  const [dropFiles, setDropFiles] = useState<File[] | undefined>(undefined)
  const dragDepthRef = useRef(0)

  // Timeline resize/collapse (spec 16 B). Both are ephemeral view state (like cameraView).
  const [timelineHeight, setTimelineHeight] = useState<number>(defaultTimelineHeight)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  // Suppress the collapse height-transition while the user is dragging the splitter — otherwise the
  // 200ms ease lags a frame behind the cursor on every resize move.
  const [isResizingTimeline, setIsResizingTimeline] = useState(false)
  const splitterDragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const handleSplitterDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    splitterDragRef.current = { startY: e.clientY, startHeight: timelineHeight }
    setIsResizingTimeline(true)
  }, [timelineHeight])

  // Splitter drag (B1/B2) + re-clamp on window resize (B5).
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = splitterDragRef.current
      if (!d) return
      // Drag up (smaller clientY) grows the timeline; down shrinks it.
      setTimelineHeight(clampTimelineHeight(d.startHeight - (e.clientY - d.startY)))
    }
    const onUp = () => { if (splitterDragRef.current) { splitterDragRef.current = null; setIsResizingTimeline(false) } }
    const onResize = () => setTimelineHeight((h) => clampTimelineHeight(h))
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const selectedObject = project.objects.find((o) => o.id === selectedObjectId) ?? null
  const selectedZoom = project.zooms?.find((z) => z.id === selectedZoomId) ?? null
  const selectedEffect = project.effects?.find((e) => e.id === selectedEffectId) ?? null

  // Draw mode only enabled when an arrow or freehand object is selected
  const drawEnabled = selectedObject != null && (selectedObject.type === 'arrow' || selectedObject.type === 'freehand')

  // interactionMode is now DERIVED (spec 17 M): "draw" only while actively drawing the selected
  // object, else "move". Canvas + PropertiesPanel still consume this as the draw-vs-move signal.
  const interactionMode: InteractionMode = drawingObjectId != null && drawingObjectId === selectedObjectId ? 'draw' : 'move'

  // Tighten bounding box for drawable objects (arrow/freehand)
  const tightenBbox = useCallback((objId: string) => {
    const obj = project.objects.find((o) => o.id === objId)
    if (!obj) return
    if (obj.type !== 'arrow' && obj.type !== 'freehand') return

    // Collect all points (arrows use points, freehand uses strokes)
    const allPoints = obj.type === 'arrow'
      ? (obj.data as ArrowData).points
      : (obj.data as FreehandData).strokes.flat()
    if (allPoints.length < 2) return

    const PADDING = 0.05 // 5% padding in normalized object-local space

    // Find extents of points (in object-local 0–1)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of allPoints) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }

    // Add padding
    const rangeX = maxX - minX || 0.01
    const rangeY = maxY - minY || 0.01
    const padX = rangeX * PADDING
    const padY = rangeY * PADDING
    minX -= padX
    minY -= padY
    maxX += padX
    maxY += padY

    // Compute new bbox in canvas-normalized coords
    const newX = obj.x + minX * obj.width
    const newY = obj.y + minY * obj.height
    const newW = (maxX - minX) * obj.width
    const newH = (maxY - minY) * obj.height

    const renorm = (p: { x: number; y: number }) => ({
      x: (p.x - minX) / (maxX - minX),
      y: (p.y - minY) / (maxY - minY),
    })

    // Renormalize points to the new bbox
    const newData: ArrowData | FreehandData = obj.type === 'arrow'
      ? { ...(obj.data as ArrowData), points: (obj.data as ArrowData).points.map(renorm) }
      : { strokes: (obj.data as FreehandData).strokes.map((s) => s.map(renorm)) }

    dispatch({
      type: 'UPDATE_OBJECT',
      objectId: obj.id,
      updates: {
        x: newX,
        y: newY,
        width: newW,
        height: newH,
        data: newData,
      },
    })
  }, [project.objects, dispatch])

  // Track previous selected object so we can tighten its bbox when selection changes
  const prevSelectedIdRef = useRef<string | null>(null)

  // Tighten bbox whenever selection moves away from a drawable object
  useEffect(() => {
    const prevId = prevSelectedIdRef.current
    if (prevId && prevId !== selectedObjectId) {
      tightenBbox(prevId)
    }
    prevSelectedIdRef.current = selectedObjectId
  }, [selectedObjectId, tightenBbox])

  // Safety net: if we're "drawing" but that object is no longer the selected drawable (deselected,
  // a different object selected, or its type changed), stop drawing. Tightening happens on the
  // explicit finish paths + the select-away effect, so we only clear here.
  useEffect(() => {
    if (drawingObjectId && (drawingObjectId !== selectedObjectId || !drawEnabled)) {
      setDrawingObjectId(null)
    }
  }, [drawingObjectId, selectedObjectId, drawEnabled])

  const handleExportProject = useCallback(async () => {
    await exportProjectBrep(project)
    markSaved() // the .gerty file now matches the in-memory project → clear the unsaved-changes guard
  }, [project, markSaved])

  const handleImportProject = useCallback(async (file: File) => {
    try {
      const imported = await importProjectBrep(file)
      dispatch({ type: 'SET_PROJECT', project: imported })
    } catch (e) {
      console.error('Failed to import project:', e)
      alert('Failed to import project file.')
    }
  }, [dispatch])

  // Loading a .gerty replaces the whole project, discarding any unsaved edits — confirm first.
  const handleLoadClick = useCallback(() => {
    if (isDirty && !window.confirm('You have unsaved changes that will be lost. Load a different project anyway?')) {
      return
    }
    projectFileRef.current?.click()
  }, [isDirty])

  // Warn before closing/refreshing the tab with unsaved changes (native browser dialog — a custom
  // modal can't be shown during beforeunload). Only attach the listener while actually dirty.
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // some browsers require returnValue to be set to trigger the prompt
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // Central helper: assigns each object to a new lane above all existing objects,
  // dispatches, and selects the newly-added object (the last one when adding several)
  // so freshly added assets and annotations become the active selection consistently.
  const addObjects = useCallback((objects: TimelineObject[]) => {
    const maxLane = project.objects.reduce((max, o) => Math.max(max, o.lane), -1)
    const withLanes = objects.map((obj, i) => ({ ...obj, lane: maxLane + 1 + i }))
    dispatch({ type: 'ADD_OBJECTS', objects: withLanes })
    const last = withLanes[withLanes.length - 1]
    if (last) {
      setSelectedObjectIds([last.id])
      setSelectedZoomId(null) // object/zoom/effect selection are mutually exclusive
      setSelectedEffectId(null)
    }
    // Adding/importing anything drops back to Frame view so the new object is visible + editable
    // (Live view hides the whole scene outside the zoom and disables editing).
    setCameraView('frame')
    return withLanes
  }, [project.objects, dispatch])

  // Re-add an already-imported asset (spec 17 L) as a new object at the playhead — no re-import,
  // reuses the existing assetId. Mirrors ImportModal's object creation, including regenerating the
  // audio/video waveform from the cached blob so the timeline bar shows it like a fresh import.
  const handleAddExistingAsset = useCallback(async (assetId: string) => {
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) return
    const startTime = playback.globalTime
    const dur = asset.duration ?? 5
    const name = asset.filename.replace(/\.[^.]+$/, '')
    let obj: TimelineObject
    if (asset.type === 'image') {
      // Animated images (spec 28 B4) default to exactly one loop; stills keep the 5s default.
      const photoData: PhotoData = asset.animated
        ? { assetId, animated: true, animationDuration: asset.duration ?? 0 }
        : { assetId }
      const imageDuration = asset.animated && asset.duration ? asset.duration : 5
      obj = createTimelineObject('photo', photoData, { startTime, duration: imageDuration, x: 0, y: 0, width: 1, height: 1, name })
    } else {
      // Regenerate the waveform from the cached blob (silent/unsupported media falls through).
      let waveform: number[] | undefined
      const blob = getAssetBlob(assetId)
      if (blob) {
        try { waveform = await generateWaveform(blob) } catch { /* no audio track / decode failed */ }
      }
      obj = asset.type === 'audio'
        ? createTimelineObject('audio', { assetId, volume: 1, originalDuration: dur, waveform, sourceIn: 0, sourceOut: dur }, { startTime, duration: dur, name })
        : createTimelineObject('video', { assetId, volume: 1, originalDuration: dur, waveform, sourceIn: 0, sourceOut: dur }, { startTime, duration: dur, x: 0, y: 0, width: 1, height: 1, name })
    }
    addObjects([obj])
  }, [project.assets, playback.globalTime, addObjects])

  const handleCreateObject = useCallback((type: TimelineObjectType) => {
    const defaultData: Record<TimelineObjectType, () => ReturnType<typeof createTimelineObject>['data']> = {
      arrow: () => ({ points: [], headSize: 20, curvature: 0, progressiveHead: true }),
      text: () => ({ content: 'Text', align: 'center', autoSize: true }),
      rectangle: () => ({} as Record<string, never>),
      circle: () => ({} as Record<string, never>),
      freehand: () => ({ strokes: [] }),
      photo: () => ({ assetId: '' }),
      audio: () => ({ assetId: '', volume: 1, originalDuration: 0 }),
      video: () => ({ assetId: '', volume: 1, originalDuration: 0 }),
    }

    // Seed new objects from the last-used settings for this type (colour, size, bold/italic,
    // text background/align, arrow head/curve, …) so they carry forward like most editors do.
    const baseData = defaultData[type]()
    const rememberedData = getRememberedData(type)
    const data = rememberedData
      ? ({ ...(baseData as object), ...rememberedData } as ReturnType<typeof createTimelineObject>['data'])
      : baseData

    // Text reads best white by default (over photos/video); annotations keep the factory red.
    // Last-used style still wins, so once you pick a text colour it carries forward.
    const remembered = getRememberedStyle(type)
    const style = type === 'text' ? { color: '#FFFFFF', ...remembered } : remembered

    // Shapes (rect/circle) aren't drag-drawn — they drop as a centered mid-frame box the user then
    // moves/resizes on canvas (full-frame would just outline the whole frame). Text has its own box;
    // arrow/freehand/photo/media fill the frame (0,0,1,1) and are positioned by drawing/cover-fit.
    const isShape = type === 'rectangle' || type === 'circle'
    const obj = createTimelineObject(type, data, {
      startTime: playback.globalTime,
      duration: 5,
      x: type === 'text' ? 0.3 : isShape ? 0.3 : 0,
      y: type === 'text' ? 0.4 : isShape ? 0.3 : 0,
      width: type === 'text' ? 0.4 : isShape ? 0.4 : 1,
      height: type === 'text' ? 0.2 : isShape ? 0.4 : 1,
      style,
    })

    addObjects([obj])

    // Arrow/freehand: drop straight into drawing the new object (spec 17 M). Others aren't drawn.
    setDrawingObjectId(type === 'arrow' || type === 'freehand' ? obj.id : null)
  }, [playback.globalTime, addObjects])

  // Create a camera zoom (spec 13) at the playhead: mirrors + Text (App.handleCreateObject).
  // Defaults from createCameraZoom; select it (clearing object selection) so its panel + framing
  // rectangle are immediately editable.
  const handleCreateZoom = useCallback(() => {
    const zoom = createCameraZoom({ startTime: playback.globalTime })
    dispatch({ type: 'ADD_ZOOM', zoom })
    setSelectedObjectIds([])
    setSelectedZoomId(zoom.id)
    setSelectedEffectId(null)
    setDrawingObjectId(null)
    setCameraView('frame') // author the new zoom un-zoomed with its framing rectangle (R8/R15)
  }, [playback.globalTime, dispatch])

  const handleSelectZoom = useCallback((id: string | null) => {
    setSelectedZoomId(id)
    if (id) {
      setSelectedObjectIds([]) // object/zoom/effect selection are mutually exclusive
      setSelectedEffectId(null)
      setDrawingObjectId(null)
    }
  }, [])

  // Create a video effect (spec 23) at the playhead: mirrors handleCreateZoom. Select it (clearing
  // object + zoom selection) so its editor is immediately shown in the panel.
  const handleCreateEffect = useCallback((kind: VideoEffectKind) => {
    const effect = createVideoEffect(kind, { startTime: playback.globalTime })
    dispatch({ type: 'ADD_EFFECT', effect })
    setSelectedObjectIds([])
    setSelectedZoomId(null)
    setSelectedEffectId(effect.id)
    setDrawingObjectId(null)
  }, [playback.globalTime, dispatch])

  // Apply an effect preset (spec 26): build its stack at the playhead and add it as ONE undo entry.
  // Select the first effect so the panel confirms something landed; the rest show on the Effects track.
  const handleApplyPreset = useCallback((presetId: string) => {
    const preset = EFFECT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    const effects = buildPresetEffects(preset, playback.globalTime)
    if (effects.length === 0) return
    dispatch({ type: 'ADD_EFFECTS', effects })
    setSelectedObjectIds([])
    setSelectedZoomId(null)
    setSelectedEffectId(effects[0].id)
    setDrawingObjectId(null)
  }, [playback.globalTime, dispatch])

  const handleSelectEffect = useCallback((id: string | null) => {
    setSelectedEffectId(id)
    if (id) {
      setSelectedObjectIds([]) // object/zoom/effect selection are mutually exclusive
      setSelectedZoomId(null)
      setDrawingObjectId(null)
    }
  }, [])

  const toggleCameraView = useCallback(() => {
    setCameraView((v) => (v === 'frame' ? 'live' : 'frame'))
  }, [])

  // Markers (spec 22). Add one at the playhead (works while playing — "tap to the beat"); step the
  // playhead to the previous/next marker; clear them all. No selection state — markers are edited
  // via a click-popover on their flag (in Timeline).
  const handleAddMarker = useCallback(() => {
    dispatch({ type: 'ADD_MARKER', marker: createMarker({ time: playback.globalTime }) })
  }, [dispatch, playback.globalTime])

  // Add a marker at an explicit, typed-in time (TransportBar's clock popover). Clamp to >= 0.
  const handleAddMarkerAt = useCallback((time: number) => {
    dispatch({ type: 'ADD_MARKER', marker: createMarker({ time: Math.max(0, time) }) })
  }, [dispatch])

  const handleStepMarker = useCallback((dir: 1 | -1) => {
    const times = (project.markers ?? []).map((m) => m.time).sort((a, b) => a - b)
    if (times.length === 0) return
    const t = playback.globalTime
    const target = dir === 1
      ? times.find((x) => x > t + 1e-4)
      : [...times].reverse().find((x) => x < t - 1e-4)
    if (target !== undefined) playback.seek(target)
  }, [project.markers, playback])

  const handleClearMarkers = useCallback(() => {
    dispatch({ type: 'CLEAR_MARKERS' })
  }, [dispatch])

  // Finish arrow drawing: tighten bbox + switch to move mode
  const handleFinishArrow = useCallback(() => {
    if (selectedObjectId) {
      tightenBbox(selectedObjectId)
    }
    setDrawingObjectId(null)
  }, [selectedObjectId, tightenBbox])

  // Toggle drawing/editing the selected arrow/freehand's points ("Edit points", spec 17 M). Used by
  // the properties panel now; moves to the object's floating context toolbar in spec 17 P.
  const handleToggleDrawSelected = useCallback(() => {
    if (!drawEnabled || !selectedObjectId) return
    if (drawingObjectId === selectedObjectId) {
      tightenBbox(selectedObjectId)
      setDrawingObjectId(null)
    } else {
      setDrawingObjectId(selectedObjectId)
    }
  }, [drawEnabled, selectedObjectId, drawingObjectId, tightenBbox])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === ' ') {
        e.preventDefault()
        playback.togglePlayback()
      } else if (e.key === 'v') {
        toggleCameraView()
      } else if (e.key === 'm' || e.key === 'M') {
        // Add a marker at the playhead (spec 22). Works while playing = tap-to-the-beat.
        handleAddMarker()
      } else if (e.key === ',') {
        handleStepMarker(-1)
      } else if (e.key === '.') {
        handleStepMarker(1)
      } else if (e.key === 'h' || e.key === 'H') {
        // Toggle hidden on the selected object OR zoom (spec 14 R11; selection is mutually exclusive).
        if (selectedObject) {
          dispatch({ type: 'UPDATE_OBJECT', objectId: selectedObject.id, updates: { hidden: !selectedObject.hidden } })
        } else if (selectedZoom) {
          dispatch({ type: 'UPDATE_ZOOM', zoomId: selectedZoom.id, updates: { hidden: !selectedZoom.hidden } })
        }
      } else if (e.key === 's' || e.key === 'S') {
        // Slice a selected audio/video clip at the playhead (spec 14 R10). No-op unless the
        // playhead is strictly inside the clip. The left half reuses the original id, so the
        // current selection stays on it (R10.6) — no re-selection needed.
        if (selectedObject && (selectedObject.type === 'audio' || selectedObject.type === 'video')) {
          const t = playback.globalTime
          if (t > selectedObject.startTime && t < selectedObject.startTime + selectedObject.duration) {
            dispatch({ type: 'SPLIT_OBJECT', objectId: selectedObject.id, globalTime: t })
          }
        }
      } else if (e.key === 'Enter' && interactionMode === 'draw' && selectedObject?.type === 'arrow') {
        // Finish arrow drawing with Enter
        const data = selectedObject.data as ArrowData
        if (data.points.length >= 2) {
          handleFinishArrow()
        }
      } else if (e.key === 'Escape') {
        if (interactionMode === 'draw') {
          // Finishing a drawing (arrow/freehand): stop drawing but KEEP the object selected and
          // tighten its bbox — matches the other finish gestures (right-click / Enter / Done).
          handleFinishArrow()
        } else {
          setDrawingObjectId(null)
          setSelectedObjectIds([])
          setSelectedZoomId(null)
          setSelectedEffectId(null)
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedZoom) {
        dispatch({ type: 'REMOVE_ZOOM', zoomId: selectedZoom.id })
        setSelectedZoomId(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEffect) {
        dispatch({ type: 'REMOVE_EFFECT', effectId: selectedEffect.id })
        setSelectedEffectId(null)
      } else if (e.key === 'Backspace' && interactionMode === 'draw' && selectedObject?.type === 'arrow') {
        // Remove last arrow point
        e.preventDefault()
        const data = selectedObject.data as ArrowData
        if (data.points.length > 0) {
          dispatch({
            type: 'UPDATE_OBJECT',
            objectId: selectedObject.id,
            updates: { data: { ...data, points: data.points.slice(0, -1) } },
          })
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedObjectIds.length > 0) {
        // Deletes the whole selection — one object or a shift-selected group across lanes.
        for (const id of selectedObjectIds) dispatch({ type: 'REMOVE_OBJECT', objectId: id })
        setSelectedObjectIds([])
      } else if (e.ctrlKey && e.key === 'z') {
        e.preventDefault()
        undo()
      } else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault()
        redo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [playback, interactionMode, selectedObject, selectedObjectIds, selectedZoom, selectedEffect, drawEnabled, dispatch, undo, redo, handleFinishArrow, toggleCameraView, handleAddMarker, handleStepMarker])

  // `additive` (shift-click from the timeline) toggles the id in/out of the multi-selection instead
  // of replacing it — letting the user gather clips across lanes to move them in time together.
  const handleSelectObject = useCallback((id: string | null, additive = false) => {
    if (id && additive) {
      setSelectedZoomId(null); setSelectedEffectId(null); setDrawingObjectId(null)
      setSelectedObjectIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
      return
    }
    setSelectedObjectIds(id ? [id] : [])
    if (id) { setSelectedZoomId(null); setSelectedEffectId(null) } // object/zoom/effect selection are mutually exclusive
    // Selecting no longer auto-enters draw (spec 17 M) — selection means "move". Re-edit an
    // arrow/freehand's points via the panel's "Edit points". Selecting away finishes any drawing.
    setDrawingObjectId(null)
  }, [])

  // Duplicate → drop the copy at the current playhead on a new lane above (reducer), then select it
  // so the new clip is the one under the cursor/panel — otherwise it lands identical-on-top and reads
  // as "nothing happened". App owns the new id so it can select the copy the reducer creates.
  const handleDuplicateObject = useCallback((objectId: string) => {
    if (!project.objects.some((o) => o.id === objectId)) return
    const newId = crypto.randomUUID()
    dispatch({ type: 'DUPLICATE_OBJECT', objectId, newId, startTime: playback.globalTime })
    handleSelectObject(newId)
  }, [project.objects, playback.globalTime, dispatch, handleSelectObject])

  // Download a media object back to disk — either its untouched source ('original') or a
  // re-encode reflecting its edits ('processed': trimmed clip / extracted audio). The processed
  // path runs the export encoders on the main thread, so it can take a moment on long clips.
  const handleDownloadObject = useCallback(async (objectId: string, mode: 'original' | 'processed') => {
    const obj = project.objects.find((o) => o.id === objectId)
    if (!obj) return
    if (mode === 'original') {
      try { downloadOriginal(obj, project.assets) }
      catch (err) { pushToast(`Download failed: ${err instanceof Error ? err.message : String(err)}`, 'error') }
      return
    }
    const toastId = pushToast('Preparing download…', 'info')
    try {
      await downloadProcessed(obj, project)
      dismissToast(toastId)
      pushToast('Download ready', 'success')
    } catch (err) {
      dismissToast(toastId)
      pushToast(`Download failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [project])

  // Window-level file drag-and-drop → import (spec 31 B1-B4, B14). A drop anywhere opens ImportModal
  // pre-staged. A drag-depth counter keeps the overlay flicker-free (dragenter/leave fire per child).
  // `dragover` MUST preventDefault or the browser navigates to the file. Dropping ON the open modal is
  // handled by the modal (it stopPropagation's), so this only fires for drops elsewhere (append, B9).
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current += 1
      setIsFileDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setIsFileDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current = 0
      setIsFileDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      const supported = files.filter(isSupportedMediaFile)
      const unsupported = files.filter((f) => !isSupportedMediaFile(f))
      if (unsupported.length > 0) {
        pushToast(`Can't import: ${unsupported.map((f) => f.name).join(', ')}`, 'error')
      }
      if (supported.length === 0) return // all unsupported → toast only, no empty modal (B14)
      setDropFiles(supported)            // fresh array each drop → modal stages / appends (B9)
      setShowImport(true)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className="h-screen flex flex-col bg-bg text-fg">
      {/* Top Bar */}
      <header className="h-12 flex items-center justify-between px-4 bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={project.name}
            onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
            className="bg-transparent text-fg font-semibold text-sm border-b border-transparent hover:border-border-strong focus:border-accent outline-none px-1 py-0.5"
          />
          <button
            onClick={handleExportProject}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-fg bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
            title="Save project as .gerty"
          >
            <IconDeviceFloppy size={14} stroke={2} /> Save
          </button>
          <button
            onClick={handleLoadClick}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-fg bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
            title="Load project from .gerty"
          >
            <IconFolderOpen size={14} stroke={2} /> Load
          </button>
          <input
            ref={projectFileRef}
            type="file"
            accept=".gerty,.tve"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleImportProject(file)
              e.target.value = ''
            }}
          />
          <span className="w-px h-6 bg-border" />
          <AspectRatioSelector width={project.width} height={project.height} dispatch={dispatch} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={undo}
            disabled={!canUndo}
            className="flex items-center px-2 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-30 transition-colors cursor-pointer"
            title="Undo (Ctrl+Z)"
          >
            <IconArrowBackUp size={18} stroke={2} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="flex items-center px-2 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-30 transition-colors cursor-pointer"
            title="Redo (Ctrl+Y)"
          >
            <IconArrowForwardUp size={18} stroke={2} />
          </button>
          <span className="w-px h-6 bg-border" />
          {/* Play / speed / volume / time moved to the floating TransportBar (spec 17 C). */}
          <AppearanceControls
            theme={uiPrefs.theme}
            onToggleTheme={uiPrefs.toggleTheme}
          />
          <button
            onClick={() => setShowHotkeys(true)}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors"
          >
            <IconKeyboard size={16} stroke={2} />
          </button>
          <button
            onClick={() => setShowChangelog(true)}
            title="What's new"
            aria-label="What's new"
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors"
          >
            <IconHistory size={16} stroke={2} />
          </button>
          <a
            href="https://buymeacoffee.com/tmcgry"
            target="_blank"
            rel="noopener noreferrer"
            title="Buy me a coffee"
            aria-label="Buy me a coffee"
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:text-fg hover:bg-surface-hover cursor-pointer transition-colors"
          >
            <IconCoffee size={16} stroke={2} />
          </a>
          <span className="w-px h-6 bg-border" />
          <button
            onClick={() => setShowExport(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-accent-contrast rounded font-medium transition-colors cursor-pointer"
          >
            <IconDownload size={15} stroke={2} /> Export
          </button>
        </div>
      </header>

      {/* Main Content: LeftRail + Viewport (with floating transport) + Properties */}
      <div className="flex-1 flex min-h-0">
        <LeftRail
          assets={project.assets}
          onAddMedia={() => setShowImport(true)}
          onAddAsset={handleAddExistingAsset}
          onCreateObject={handleCreateObject}
          onCreateZoom={handleCreateZoom}
          onCreateEffect={handleCreateEffect}
          onApplyPreset={handleApplyPreset}
        />
        <div className="relative flex flex-1 min-w-0">
        <Canvas
          objects={project.objects}
          globalTime={playback.globalTime}
          isPlaying={playback.isPlaying}
          width={project.width}
          height={project.height}
          selectedObjectId={selectedObjectId}
          interactionMode={interactionMode}
          dispatch={dispatch}
          onFinishArrow={handleFinishArrow}
          zooms={project.zooms}
          selectedZoomId={selectedZoomId}
          onSelectZoom={handleSelectZoom}
          cameraView={cameraView}
          onToggleCameraView={toggleCameraView}
          effects={project.effects}
          onToggleDraw={handleToggleDrawSelected}
          onDuplicate={handleDuplicateObject}
          assets={project.assets}
        />
          {/* Floating transport pill (spec 17 C) — centered over the canvas, in the render's bottom
              gutter. The container ignores pointer events; the pill re-enables them so it never
              blocks canvas interaction. Works whether the timeline is expanded or collapsed. */}
          <div className="absolute bottom-5 inset-x-0 flex justify-center pointer-events-none z-20">
            <TransportBar
              isPlaying={playback.isPlaying}
              onTogglePlayback={playback.togglePlayback}
              globalTime={playback.globalTime}
              totalDuration={playback.totalDuration}
              playbackSpeed={playback.playbackSpeed}
              onSetSpeed={playback.setPlaybackSpeed}
              volume={volume}
              isMuted={isMuted}
              onVolume={setVolume}
              onToggleMute={toggleMute}
              onAddMarker={handleAddMarker}
              onAddMarkerAt={handleAddMarkerAt}
              onClearMarkers={handleClearMarkers}
              markerCount={project.markers?.length ?? 0}
            />
          </div>
        </div>

        <PropertiesPanel
          object={selectedObject}
          zoom={selectedZoom}
          effect={selectedEffect}
          dispatch={dispatch}
          globalTime={playback.globalTime}
          onSeek={playback.seek}
          isDrawing={interactionMode === 'draw'}
          onToggleDraw={handleToggleDrawSelected}
          onDuplicate={handleDuplicateObject}
          onDownload={handleDownloadObject}
          assets={project.assets}
        />
      </div>

      {/* Timeline (spec 16 B): bounded height, resizable via a splitter, collapsible to a slim bar.
          The whole area sits in a height-animated wrapper (overflow clipped) so collapse/expand slides
          instead of snapping. The transition is suppressed mid-resize so splitter drags stay 1:1. */}
      <div
        className={`shrink-0 overflow-hidden bg-surface flex flex-col ${isResizingTimeline ? '' : 'transition-[height] duration-200 ease-out'}`}
        style={{ height: timelineCollapsed ? COLLAPSED_TIMELINE_HEIGHT : SPLITTER_HEIGHT + timelineHeight }}
      >
        {timelineCollapsed ? (
          // Expand toggle lives in the SAME left cell as the collapse chevron (Timeline's gutter,
          // width 32 = GUTTER_WIDTH) so collapse→expand needs zero mouse travel (spec 31 A1).
          <div className="flex items-center bg-surface border-t border-border" style={{ height: COLLAPSED_TIMELINE_HEIGHT }}>
            <button
              onClick={() => setTimelineCollapsed(false)}
              className="h-full flex items-center justify-center bg-surface-muted border-r border-border text-subtle hover:text-fg transition-colors cursor-pointer"
              style={{ width: 32 }}
              title="Expand timeline"
            >
              <IconChevronUp size={14} stroke={2} />
            </button>
            <span className="text-xs text-muted px-3">Timeline</span>
          </div>
        ) : (
          <>
            {/* Drag handle — resize the render / timeline split */}
            <div
              onMouseDown={handleSplitterDown}
              className="shrink-0 h-1.5 cursor-row-resize bg-border hover:bg-accent/60 transition-colors"
              title="Drag to resize timeline"
            />
            <div className="shrink-0" style={{ height: timelineHeight }}>
              <Timeline
                objects={project.objects}
                globalTime={playback.globalTime}
                totalDuration={playback.totalDuration}
                selectedObjectIds={selectedObjectIds}
                onSelectObject={handleSelectObject}
                onSeek={playback.seek}
                dispatch={dispatch}
                zooms={project.zooms}
                selectedZoomId={selectedZoomId}
                onSelectZoom={handleSelectZoom}
                effects={project.effects}
                selectedEffectId={selectedEffectId}
                onSelectEffect={handleSelectEffect}
                markers={project.markers}
                onCollapse={() => setTimelineCollapsed(true)}
              />
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {showImport && (
        <ImportModal
          onImport={addObjects}
          onClose={() => { setShowImport(false); setDropFiles(undefined) }}
          insertAtTime={playback.globalTime}
          onAssetsAdded={(assets) => dispatch({ type: 'ADD_ASSETS', assets })}
          initialFiles={dropFiles}
        />
      )}
      {showExport && <ExportModal project={project} onClose={() => setShowExport(false)} />}
      {showHotkeys && <HotkeysModal onClose={() => setShowHotkeys(false)} />}
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}

      {/* Drop-to-import affordance (spec 31 B2). Hidden once the modal is open — the modal has its own
          drop zone. pointer-events-none so it never intercepts the drag/drop events themselves. */}
      {isFileDragging && !showImport && (
        <div className="fixed inset-0 z-150 pointer-events-none flex items-center justify-center bg-accent/10">
          <div className="rounded-xl border-2 border-dashed border-accent bg-surface/95 px-8 py-6 text-center shadow-xl">
            <div className="text-lg font-semibold text-fg">Drop to import</div>
            <div className="text-sm text-muted mt-1">Images, video, and audio</div>
          </div>
        </div>
      )}

      <Toasts />
    </div>
  )
}
