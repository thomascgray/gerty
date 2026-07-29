import { useState, useRef, useCallback, useEffect } from 'react'
import type { Project } from '../types'

// Preview-only playback speed bounds (does NOT affect export).
const PREVIEW_SPEED_MIN = 0.25
const PREVIEW_SPEED_MAX = 2

export function usePlayback(project: Project) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [globalTime, setGlobalTime] = useState(0)
  const rafRef = useRef<number>(0)
  const lastFrameTimeRef = useRef<number>(0)

  // Editor-preview playback speed: scales how fast the playhead advances when you hit Play in the
  // app. A monitoring convenience only — export renders at real speed regardless. A ref lets the
  // rAF tick read the live value without re-subscribing the loop.
  const [playbackSpeed, setPlaybackSpeedState] = useState(1)
  const playbackSpeedRef = useRef(1)
  const setPlaybackSpeed = useCallback((s: number) => {
    const clamped = Math.max(PREVIEW_SPEED_MIN, Math.min(PREVIEW_SPEED_MAX, s))
    playbackSpeedRef.current = clamped
    setPlaybackSpeedState(clamped)
  }, [])

  // Total duration = furthest endTime of any object
  const totalDuration = project.objects.reduce(
    (max, obj) => Math.max(max, obj.startTime + obj.duration),
    0,
  )

  const totalDurationRef = useRef(totalDuration)

  useEffect(() => {
    totalDurationRef.current = totalDuration
  }, [totalDuration])

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current)
      return
    }

    lastFrameTimeRef.current = 0

    const tick = (timestamp: number) => {
      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = timestamp
      }
      const delta = (timestamp - lastFrameTimeRef.current) / 1000
      lastFrameTimeRef.current = timestamp

      setGlobalTime((prev) => {
        const next = prev + delta * playbackSpeedRef.current
        if (next >= totalDurationRef.current) {
          // Park on the last frame rather than rewinding — the playhead stays where
          // playback ended so you can inspect/edit the final frame.
          setIsPlaying(false)
          return totalDurationRef.current
        }
        return next
      })

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isPlaying])

  // Playback parks on the last frame when it finishes, so hitting Play from there rewinds
  // to the start instead of instantly re-ending.
  const rewindIfAtEnd = useCallback(() => {
    setGlobalTime((t) => (t >= totalDurationRef.current ? 0 : t))
  }, [])

  const play = useCallback(() => {
    if (totalDurationRef.current <= 0) return
    rewindIfAtEnd()
    setIsPlaying(true)
  }, [rewindIfAtEnd])
  const pause = useCallback(() => setIsPlaying(false), [])
  const togglePlayback = useCallback(() => {
    if (totalDurationRef.current <= 0) return
    setIsPlaying((p) => {
      if (!p) rewindIfAtEnd()
      return !p
    })
  }, [rewindIfAtEnd])

  const seek = useCallback(
    (time: number) => {
      setGlobalTime(Math.max(0, Math.min(time, totalDuration)))
    },
    [totalDuration],
  )

  return {
    isPlaying,
    globalTime,
    totalDuration,
    play,
    pause,
    togglePlayback,
    seek,
    playbackSpeed,
    setPlaybackSpeed,
  }
}
