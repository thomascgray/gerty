import { useEffect, useRef, useState, useCallback } from 'react'
import type { TimelineObject, AudioData, VideoData } from '../types'
import { getAssetUrl } from '../lib/assetStore'
import { registerVideoElement, unregisterVideoElement, notifyVideoReady } from '../lib/mediaRegistry'
import { clipRate, sourceTimeAt } from '../lib/mediaTiming'
import { resolvedGainAt } from '../lib/loudness'

type MediaEntry = {
  objectId: string
  assetId: string
  element: HTMLAudioElement | HTMLVideoElement
  // Web Audio graph (spec 38): element -> sourceNode -> gainNode -> masterGain -> destination.
  // Routing through the graph is what lets a clip exceed 100% and apply the time-varying auto-level
  // envelope, neither of which HTMLMediaElement.volume (clamped to [0,1], no automation) can do.
  sourceNode: MediaElementAudioSourceNode
  gainNode: GainNode
  originalDuration: number
}

/**
 * Manages HTMLMediaElements for audio/video clips, synced to the timeline.
 * Handles play/pause/seek, playbackRate, volume, mute, and per-clip auto-level (spec 38).
 *
 * Audio routes through a shared Web Audio graph: each element feeds a per-clip GainNode (its
 * volume * auto-level envelope, resolved by resolvedGainAt) into a single master GainNode (the
 * preview monitoring level + master mute) into the destination.
 */
export function useAudioPlayback(
  objects: TimelineObject[],
  globalTime: number,
  isPlaying: boolean,
  // Preview playback speed (usePlayback) — the playhead advances this much faster, so each media
  // element must play at rate * previewSpeed to stay in sync. Export is unaffected (separate path).
  previewSpeed = 1,
) {
  const [isMuted, setIsMuted] = useState(false)
  // Master preview volume (0–1). A monitoring level for playback only (export mixes each clip at its
  // own volume, independent of this). Per-clip volume (0–2) + auto-level live on each clip's gainNode.
  const [volume, setVolumeState] = useState(1)
  const volumeRef = useRef(1)
  const mutedRef = useRef(false)
  const entriesRef = useRef<Map<string, MediaEntry>>(new Map())
  const globalTimeRef = useRef(globalTime)
  globalTimeRef.current = globalTime

  const audioCtxRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

  // Lazily create the shared AudioContext + master gain (first time any element is registered).
  const getCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext()
      const master = ctx.createGain()
      master.gain.value = mutedRef.current ? 0 : volumeRef.current
      master.connect(ctx.destination)
      audioCtxRef.current = ctx
      masterGainRef.current = master
    }
    return audioCtxRef.current
  }, [])

  // Push the master level (volume + mute) onto the master gain node.
  const applyMaster = useCallback(() => {
    const ctx = audioCtxRef.current
    const master = masterGainRef.current
    if (!ctx || !master) return
    master.gain.setTargetAtTime(mutedRef.current ? 0 : volumeRef.current, ctx.currentTime, 0.01)
  }, [])

  // Per-clip gain target at the current playhead: volume * auto-level(sourceTime), resolved in source
  // time so it rides trim/speed. Auto-level off -> just the clip volume.
  const gainTargetFor = useCallback((obj: TimelineObject, data: AudioData | VideoData) => {
    const clipProgress = clamp01((globalTimeRef.current - obj.startTime) / obj.duration)
    return resolvedGainAt(data, sourceTimeAt(data, clipProgress))
  }, [])

  const setClipGain = useCallback((entry: MediaEntry, target: number, smooth: boolean) => {
    const ctx = audioCtxRef.current
    if (!ctx) { entry.gainNode.gain.value = target; return }
    if (smooth) entry.gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.03)
    else entry.gainNode.gain.setValueAtTime(target, ctx.currentTime)
  }, [])

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev
      mutedRef.current = next
      applyMaster()
      return next
    })
  }, [applyMaster])

  // Set the master volume and push it to the master gain immediately (no element churn, so dragging
  // the slider stays smooth). Raising above zero also lifts mute.
  const setVolume = useCallback((v: number) => {
    const next = clamp01(v)
    volumeRef.current = next
    setVolumeState(next)
    if (next > 0) { mutedRef.current = false; setIsMuted(false) }
    applyMaster()
  }, [applyMaster])

  // Create/destroy media elements + graph nodes when objects change
  useEffect(() => {
    const entries = entriesRef.current
    const currentIds = new Set<string>()

    for (const obj of objects) {
      if (obj.type !== 'audio' && obj.type !== 'video') continue
      // Hidden clips (spec 14 R11): don't register a media element. Not adding to
      // currentIds means the cleanup loop below pauses + unregisters any element that
      // was live before the object was hidden (so useCanvasRenderer stops blitting it).
      if (obj.hidden) continue
      currentIds.add(obj.id)

      const data = obj.data as AudioData | VideoData
      const existing = entries.get(obj.id)

      if (existing && existing.assetId === data.assetId) {
        // Update rate + gain on the existing element/node (rate honors trim: span/duration).
        existing.element.playbackRate = clipRate(data, obj.duration) * previewSpeed
        setClipGain(existing, gainTargetFor(obj, data), false)
        existing.originalDuration = data.originalDuration
        continue
      }

      // Create new element
      const url = getAssetUrl(data.assetId)
      if (!url) continue

      // Clean up old entry if asset changed (disconnect its graph nodes so they can be GC'd).
      if (existing) {
        existing.element.pause()
        existing.element.src = ''
        try { existing.sourceNode.disconnect() } catch { /* already gone */ }
        try { existing.gainNode.disconnect() } catch { /* already gone */ }
      }

      const el = obj.type === 'video'
        ? document.createElement('video')
        : document.createElement('audio')
      el.src = url
      el.preload = 'auto'
      // All gain lives in the graph now; keep the element itself neutral.
      el.volume = 1
      el.muted = false
      el.playbackRate = clipRate(data, obj.duration) * previewSpeed

      // Route through the shared Web Audio graph. createMediaElementSource can be called only ONCE
      // per element, so it's created here with the (fresh) element and torn down on churn above.
      const ctx = getCtx()
      const sourceNode = ctx.createMediaElementSource(el)
      const gainNode = ctx.createGain()
      gainNode.gain.value = gainTargetFor(obj, data)
      sourceNode.connect(gainNode)
      gainNode.connect(masterGainRef.current!)

      // Video elements double as the canvas image source (A2). playsInline lets a
      // detached element decode frames; register it so useCanvasRenderer can draw it.
      if (obj.type === 'video') {
        ;(el as HTMLVideoElement).playsInline = true
        // Paint the canvas the moment the first frame decodes, so a freshly imported
        // clip appears immediately instead of blank-until-next-scrub.
        el.addEventListener('loadeddata', notifyVideoReady)
        registerVideoElement(obj.id, el as HTMLVideoElement)
      }

      entries.set(obj.id, {
        objectId: obj.id,
        assetId: data.assetId,
        element: el,
        sourceNode,
        gainNode,
        originalDuration: data.originalDuration,
      })
    }

    // Remove entries for deleted objects
    for (const [id, entry] of entries) {
      if (!currentIds.has(id)) {
        entry.element.pause()
        entry.element.src = ''
        try { entry.sourceNode.disconnect() } catch { /* already gone */ }
        try { entry.gainNode.disconnect() } catch { /* already gone */ }
        unregisterVideoElement(id)
        entries.delete(id)
      }
    }
  }, [objects, previewSpeed, getCtx, gainTargetFor, setClipGain])

  // Sync play/pause and currentTime
  useEffect(() => {
    const entries = entriesRef.current
    // Resume the context on a play gesture (autoplay policy leaves it suspended until then).
    if (isPlaying) audioCtxRef.current?.resume().catch(() => {/* best effort */})

    for (const obj of objects) {
      if (obj.type !== 'audio' && obj.type !== 'video') continue
      if (obj.hidden) continue
      const entry = entries.get(obj.id)
      if (!entry) continue

      const el = entry.element
      const data = obj.data as AudioData | VideoData

      // Is this clip active at the current time?
      const clipStart = obj.startTime
      const clipEnd = obj.startTime + obj.duration
      const isActive = globalTime >= clipStart && globalTime < clipEnd

      if (isActive && isPlaying) {
        // Position within the source media honors trim: sourceIn + progress*span
        const clipProgress = (globalTime - clipStart) / obj.duration
        const sourceTime = sourceTimeAt(data, clipProgress)

        el.playbackRate = clipRate(data, obj.duration) * previewSpeed
        // Follow the (possibly time-varying) auto-level envelope while playing.
        setClipGain(entry, gainTargetFor(obj, data), true)

        // Only seek if we're significantly out of sync (>0.3s)
        if (Math.abs(el.currentTime - sourceTime) > 0.3) {
          el.currentTime = sourceTime
        }

        if (el.paused) {
          el.play().catch(() => {/* autoplay may be blocked */})
        }
      } else {
        if (!el.paused) {
          el.pause()
        }
        if (isActive) {
          // Paused but active — seek to correct position + set gain for that point.
          const clipProgress = (globalTime - clipStart) / obj.duration
          el.currentTime = sourceTimeAt(data, clipProgress)
          setClipGain(entry, gainTargetFor(obj, data), false)
        }
      }
    }
  }, [objects, globalTime, isPlaying, previewSpeed, gainTargetFor, setClipGain])

  // When seeking (not playing), update positions immediately
  useEffect(() => {
    if (isPlaying) return
    const entries = entriesRef.current

    for (const obj of objects) {
      if (obj.type !== 'audio' && obj.type !== 'video') continue
      if (obj.hidden) continue
      const entry = entries.get(obj.id)
      if (!entry) continue

      const clipStart = obj.startTime
      const clipEnd = obj.startTime + obj.duration
      const isActive = globalTime >= clipStart && globalTime < clipEnd

      if (isActive) {
        const data = obj.data as AudioData | VideoData
        const clipProgress = (globalTime - clipStart) / obj.duration
        entry.element.currentTime = sourceTimeAt(data, clipProgress)
        setClipGain(entry, gainTargetFor(obj, data), false)
      }
    }
  }, [objects, globalTime, isPlaying, gainTargetFor, setClipGain])

  // Cleanup on unmount
  useEffect(() => {
    const entries = entriesRef.current
    return () => {
      for (const entry of entries.values()) {
        entry.element.pause()
        entry.element.src = ''
        try { entry.sourceNode.disconnect() } catch { /* already gone */ }
        try { entry.gainNode.disconnect() } catch { /* already gone */ }
        unregisterVideoElement(entry.objectId)
      }
      entries.clear()
      audioCtxRef.current?.close().catch(() => {/* best effort */})
      audioCtxRef.current = null
      masterGainRef.current = null
    }
  }, [])

  return { isMuted, toggleMute, volume, setVolume }
}
