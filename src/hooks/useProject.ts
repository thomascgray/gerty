import { useReducer, useCallback, useEffect, useRef } from 'react'
import type { Project, ProjectAction, TimelineObject, AudioData, VideoData, Keyframe } from '../types'
import { createDefaultProject } from '../types'
import { poseAt, KF_EPS } from '../lib/keyframes'
import { srcIn, srcOut, sourceSpan } from '../lib/mediaTiming'
import { saveProject, loadProject } from '../lib/projectStorage'
import { loadCanvasSize, saveCanvasSize } from '../lib/canvasSizePref'
import { config } from '../config'

/**
 * Split an audio/video object at the playhead into two independent halves (spec 14 R10).
 * The left half REUSES the original id (an in-place shorten, so the current selection stays
 * on it — R10.6), the right half gets a fresh id. Both preserve rate = span/duration, so a
 * cut at 1× stays 1× and a 2× clip stays 2× on both sides (R10.1). data + keyframes are
 * deep-cloned per half (mirrors DUPLICATE_OBJECT) so the halves are fully independent.
 */
function splitObject(obj: TimelineObject, globalTime: number): [TimelineObject, TimelineObject] {
  const splitOffset = globalTime - obj.startTime
  const data = obj.data as AudioData | VideoData
  const inPt = srcIn(data)
  const outPt = srcOut(data)
  const span = sourceSpan(data)
  // Split point in SOURCE coords (R10.1). Uses R2's mapping directly.
  const sourceSplit = inPt + (splitOffset / obj.duration) * span

  // Keyframe bucketing (R10.3). Keyframes are clip-relative, so the right half's shift by
  // -splitOffset re-anchors them. before/at/after partition the timeline at the cut.
  const kfs = obj.keyframes ?? []
  const atKfs = kfs.filter((k) => Math.abs(k.time - splitOffset) <= KF_EPS)
  const leftKfs: Keyframe[] = kfs
    .filter((k) => k.time < splitOffset - KF_EPS)
    .map((k) => structuredClone(k))
  const rightKfs: Keyframe[] = kfs
    .filter((k) => k.time > splitOffset + KF_EPS)
    .map((k) => ({ ...structuredClone(k), time: k.time - splitOffset }))

  // A keyframe exactly on the cut is duplicated onto both halves (left end / right start).
  for (const k of atKfs) {
    leftKfs.push({ ...structuredClone(k), time: splitOffset })
    rightKfs.unshift({ ...structuredClone(k), time: 0 })
  }

  // Continuity across the cut (R10.3): when the object is keyframed and there isn't already a
  // keyframe on the cut, pin the interpolated pose at the split onto the end of the left half and
  // the start of the right half — otherwise the right half would restart its tween from the base
  // (home) pose and pop. Pinning both boundaries guarantees the pose matches on each side.
  if (kfs.length > 0 && atKfs.length === 0) {
    const atPose = poseAt(obj, splitOffset)
    const boundaryEasing = kfs.find((k) => k.time > splitOffset + KF_EPS)?.easing ?? 'linear'
    leftKfs.push({ time: splitOffset, pose: { ...atPose }, easing: boundaryEasing })
    rightKfs.unshift({ time: 0, pose: { ...atPose }, easing: boundaryEasing })
  }

  // Each half collapses its recoverable-source window (sourceMin/sourceMax) to its own played span,
  // so in the UI it reads as a fresh, UNtrimmed clip: no trim ghosts, no edge you can drag back out
  // to reveal the sibling's footage. (Decode is unaffected — sourceIn/sourceOut still map to the
  // true asset offsets.) Without this, the left half's ghost would extend right over the right half
  // and steal its clicks (and vice-versa).
  const left: TimelineObject = {
    ...obj,
    duration: splitOffset,
    data: { ...structuredClone(data), sourceIn: inPt, sourceOut: sourceSplit, sourceMin: inPt, sourceMax: sourceSplit },
    keyframes: leftKfs.length ? leftKfs : undefined,
  }
  const right: TimelineObject = {
    ...obj,
    id: crypto.randomUUID(),
    name: `${obj.name} (2)`,
    startTime: obj.startTime + splitOffset,
    duration: obj.duration - splitOffset,
    data: { ...structuredClone(data), sourceIn: sourceSplit, sourceOut: outPt, sourceMin: sourceSplit, sourceMax: outPt },
    keyframes: rightKfs.length ? rightKfs : undefined,
  }
  return [left, right]
}

type UndoableState = {
  past: Project[]
  present: Project
  future: Project[]
  /** Snapshot saved on first transient update, used for undo entry on commit */
  transientSnapshot: Project | null
  /** True when `present` differs from the last saved/loaded project (drives the leave-without-saving guard) */
  dirty: boolean
}

function projectReducer(state: UndoableState, action: ProjectAction): UndoableState {
  // Clears the unsaved-changes flag after a .tve export — no history mutation.
  if (action.type === 'MARK_SAVED') {
    return state.dirty ? { ...state, dirty: false } : state
  }

  if (action.type === 'UNDO') {
    if (state.past.length === 0) return state
    const previous = state.past[state.past.length - 1]
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future],
      transientSnapshot: null,
      dirty: true,
    }
  }

  if (action.type === 'REDO') {
    if (state.future.length === 0) return state
    const next = state.future[0]
    return {
      past: [...state.past, state.present],
      present: next,
      future: state.future.slice(1),
      transientSnapshot: null,
      dirty: true,
    }
  }

  if (action.type === 'UPDATE_OBJECT_TRANSIENT') {
    const newProject = applyAction(state.present, {
      type: 'UPDATE_OBJECT',
      objectId: action.objectId,
      updates: action.updates,
    })
    if (newProject === state.present) return state
    return {
      ...state,
      present: newProject,
      transientSnapshot: state.transientSnapshot ?? state.present,
      dirty: true,
    }
  }

  if (action.type === 'UPDATE_ZOOM_TRANSIENT') {
    const newProject = applyAction(state.present, {
      type: 'UPDATE_ZOOM',
      zoomId: action.zoomId,
      updates: action.updates,
    })
    if (newProject === state.present) return state
    return {
      ...state,
      present: newProject,
      transientSnapshot: state.transientSnapshot ?? state.present,
      dirty: true,
    }
  }

  if (action.type === 'UPDATE_EFFECT_TRANSIENT') {
    const newProject = applyAction(state.present, {
      type: 'UPDATE_EFFECT',
      effectId: action.effectId,
      updates: action.updates,
    })
    if (newProject === state.present) return state
    return {
      ...state,
      present: newProject,
      transientSnapshot: state.transientSnapshot ?? state.present,
      dirty: true,
    }
  }

  if (action.type === 'UPDATE_MARKER_TRANSIENT') {
    const newProject = applyAction(state.present, {
      type: 'UPDATE_MARKER',
      markerId: action.markerId,
      updates: action.updates,
    })
    if (newProject === state.present) return state
    return {
      ...state,
      present: newProject,
      transientSnapshot: state.transientSnapshot ?? state.present,
      dirty: true,
    }
  }

  if (action.type === 'COMMIT_TRANSIENT') {
    if (!state.transientSnapshot) return state
    return {
      past: [...state.past.slice(-49), state.transientSnapshot],
      present: state.present,
      future: [],
      transientSnapshot: null,
      dirty: true,
    }
  }

  const newProject = applyAction(state.present, action)
  if (newProject === state.present) return state

  return {
    past: [...state.past.slice(-49), state.present],
    present: newProject,
    future: [],
    transientSnapshot: null,
    // Loading/replacing the whole project (SET_PROJECT) lands on a state that matches the file
    // on disk, so it starts clean; every other mutation dirties the project.
    dirty: action.type !== 'SET_PROJECT',
  }
}

function applyAction(project: Project, action: ProjectAction): Project {
  switch (action.type) {
    case 'SET_PROJECT':
      return action.project

    case 'SET_NAME':
      return { ...project, name: action.name }

    case 'SET_DIMENSIONS':
      if (project.width === action.width && project.height === action.height) return project
      return { ...project, width: action.width, height: action.height }

    case 'ADD_OBJECTS':
      return { ...project, objects: [...project.objects, ...action.objects] }

    case 'ADD_ASSETS':
      return { ...project, assets: [...project.assets, ...action.assets] }

    case 'REMOVE_OBJECT':
      return { ...project, objects: project.objects.filter((o) => o.id !== action.objectId) }

    case 'ADD_ZOOM':
      return { ...project, zooms: [...(project.zooms ?? []), action.zoom] }

    case 'UPDATE_ZOOM':
      return {
        ...project,
        zooms: (project.zooms ?? []).map((z) =>
          z.id === action.zoomId ? { ...z, ...action.updates } : z,
        ),
      }

    case 'REMOVE_ZOOM':
      return { ...project, zooms: (project.zooms ?? []).filter((z) => z.id !== action.zoomId) }

    case 'ADD_EFFECT':
      return { ...project, effects: [...(project.effects ?? []), action.effect] }

    case 'ADD_EFFECTS':
      return { ...project, effects: [...(project.effects ?? []), ...action.effects] }

    case 'UPDATE_EFFECT':
      return {
        ...project,
        effects: (project.effects ?? []).map((e) =>
          e.id === action.effectId ? { ...e, ...action.updates } : e,
        ),
      }

    case 'REMOVE_EFFECT':
      return { ...project, effects: (project.effects ?? []).filter((e) => e.id !== action.effectId) }

    case 'ADD_MARKER':
      return { ...project, markers: [...(project.markers ?? []), action.marker] }

    case 'UPDATE_MARKER':
      return {
        ...project,
        markers: (project.markers ?? []).map((m) =>
          m.id === action.markerId ? { ...m, ...action.updates } : m,
        ),
      }

    case 'REMOVE_MARKER':
      return { ...project, markers: (project.markers ?? []).filter((m) => m.id !== action.markerId) }

    case 'CLEAR_MARKERS':
      if (!project.markers || project.markers.length === 0) return project
      return { ...project, markers: [] }

    case 'UPDATE_OBJECT':
      return {
        ...project,
        objects: project.objects.map((o) =>
          o.id === action.objectId ? { ...o, ...action.updates } : o,
        ),
      }

    case 'DUPLICATE_OBJECT': {
      const idx = project.objects.findIndex((o) => o.id === action.objectId)
      if (idx === -1) return project
      const original = project.objects[idx]
      // The copy lands at the playhead (action.startTime) on a NEW lane above everything, so it
      // shows up at the current time instead of tucked in after the original (where it was easy to
      // miss). Falls back to the old after-the-original placement / a fresh id if the caller omits
      // them. Lane = one above the current top so it stacks on top and is immediately visible.
      const topLane = project.objects.reduce((m, o) => Math.max(m, o.lane), original.lane)
      const dupe = {
        ...original,
        id: action.newId ?? crypto.randomUUID(),
        name: original.name + ' (copy)',
        startTime: action.startTime ?? original.startTime + original.duration,
        lane: topLane + 1,
        // Deep-clone nested structures so the copy is fully independent (R10) — a shallow
        // spread would share keyframe/data arrays by reference between original and copy.
        data: structuredClone(original.data),
        keyframes: original.keyframes ? structuredClone(original.keyframes) : undefined,
      }
      const objects = [...project.objects]
      objects.splice(idx + 1, 0, dupe)
      return { ...project, objects }
    }

    case 'SPLIT_OBJECT': {
      const idx = project.objects.findIndex((o) => o.id === action.objectId)
      if (idx === -1) return project
      const obj = project.objects[idx]
      if (obj.type !== 'audio' && obj.type !== 'video') return project
      const splitOffset = action.globalTime - obj.startTime
      // No-op unless the playhead is strictly inside; a small margin avoids degenerate sub-clips.
      if (splitOffset <= 0.05 || splitOffset >= obj.duration - 0.05) return project
      const [left, right] = splitObject(obj, action.globalTime)
      const objects = [...project.objects]
      objects.splice(idx, 1, left, right)  // replace original with the two halves, preserving order
      return { ...project, objects }
    }

    case 'REMOVE_LANE': {
      const laneToRemove = action.lane
      const lanes = [...new Set(project.objects.map((o) => o.lane))].sort((a, b) => a - b)
      if (lanes.length <= 1) return project // don't remove the last lane

      // Find target lane: prefer above (higher number), fall back to below
      const aboveLanes = lanes.filter((l) => l > laneToRemove)
      const belowLanes = lanes.filter((l) => l < laneToRemove).reverse()
      const targetLane = aboveLanes.length > 0 ? aboveLanes[0] : belowLanes[0]
      if (targetLane === undefined) return project

      return {
        ...project,
        objects: project.objects.map((o) =>
          o.lane === laneToRemove ? { ...o, lane: targetLane } : o,
        ),
      }
    }

    default:
      return project
  }
}

export function useProject() {
  const [state, dispatch] = useReducer(projectReducer, null, () => ({
    past: [],
    present: config.persistProject ? loadProject() : createDefaultProject(loadCanvasSize() ?? undefined),
    future: [],
    transientSnapshot: null,
    dirty: false,
  }))

  // Auto-save (debounced) — only when persistence is enabled
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!config.persistProject) return
    clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      saveProject(state.present)
    }, 1000)
    return () => clearTimeout(saveTimeoutRef.current)
  }, [state.present])

  // Remember the canvas size for the next new project (spec 18-qol R3). This preference persists
  // independently of `config.persistProject`, undo/redo, and `.tve` export — mirrors `useUiPrefs`.
  useEffect(() => {
    saveCanvasSize({ width: state.present.width, height: state.present.height })
  }, [state.present.width, state.present.height])

  const canUndo = state.past.length > 0
  const canRedo = state.future.length > 0

  const undo = useCallback(() => dispatch({ type: 'UNDO' }), [])
  const redo = useCallback(() => dispatch({ type: 'REDO' }), [])
  const markSaved = useCallback(() => dispatch({ type: 'MARK_SAVED' }), [])

  return {
    project: state.present,
    dispatch,
    canUndo,
    canRedo,
    undo,
    redo,
    isDirty: state.dirty,
    markSaved,
  }
}
