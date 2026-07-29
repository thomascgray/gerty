import { useState, useCallback, useEffect, useRef } from "react";
import type { TimelineObject, AssetMeta, PhotoData } from "../types";
import { createTimelineObject } from "../types";
import { IconX, IconAlertTriangle, IconLink } from "@tabler/icons-react";
import {
  storeAsset,
  getMediaDuration,
  generateWaveform,
  getTotalAssetSize,
  fetchAssetFromUrl,
  isFetchableUrl,
  AssetFetchError,
  SIZE_WARN_PER_FILE,
  SIZE_WARN_TOTAL,
} from "../lib/assetStore";
import { probeAnimatedImage, type AnimatedImageInfo } from "../lib/animatedImage";

type ImportModalProps = {
  onImport: (objects: TimelineObject[]) => void;
  onClose: () => void;
  insertAtTime?: number;
  onAssetsAdded?: (assets: AssetMeta[]) => void;
};

/**
 * A row in the staging list. Rows added by paste-a-URL (spec 28 A) start as
 * `loading` and resolve to `ready` or `error` in place — hence the stable `id`
 * and the optional `file`, which only exists once the bytes are actually here.
 */
type PendingAsset = {
  id: string;
  status: "ready" | "loading" | "error";
  name: string;
  file?: File;
  type?: "image" | "audio" | "video";
  previewUrl?: string;
  duration?: number;
  sizeWarning?: string;
  error?: string;
  sourceUrl?: string;
  animation?: AnimatedImageInfo;
};

/** Stage one already-fetched file: classify it, build a preview, measure it. */
async function buildPendingAsset(file: File): Promise<PendingAsset> {
  const type = file.type.startsWith("image/")
    ? "image"
    : file.type.startsWith("audio/")
      ? "audio"
      : "video";

  const asset: PendingAsset = {
    id: crypto.randomUUID(),
    status: "ready",
    file,
    type,
    name: file.name,
  };

  // Size warning
  if (file.size > SIZE_WARN_PER_FILE) {
    asset.sizeWarning = `Large file (${(file.size / 1024 / 1024).toFixed(0)} MB)`;
  }

  // Preview URL for images and videos
  if (type === "image" || type === "video") {
    asset.previewUrl = URL.createObjectURL(file);
  }

  // Get duration for audio/video
  if (type === "audio" || type === "video") {
    try {
      asset.duration = await getMediaDuration(file);
    } catch {
      // duration unknown
    }
  }

  // Animated images (spec 28 B1): measure the per-frame timings ONCE, here, so the
  // clip can default to one full loop and a reload never has to re-probe. The result
  // is kept even when it's "not animated" so storeAsset doesn't probe a second time.
  if (type === "image") {
    const info = await probeAnimatedImage(file);
    asset.animation = info;
    if (info.animated) asset.duration = info.duration;
  }

  return asset;
}

export default function ImportModal({
  onImport,
  onClose,
  insertAtTime = 0,
  onAssetsAdded,
}: ImportModalProps) {
  const [pending, setPending] = useState<PendingAsset[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Latest rows, for the unmount cleanup (which must not capture the initial state).
  const pendingRef = useRef<PendingAsset[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const addFiles = useCallback(async (files: File[]) => {
    const supported = files.filter(
      (f) =>
        f.type.startsWith("image/") ||
        f.type.startsWith("audio/") ||
        f.type.startsWith("video/")
    );
    if (supported.length === 0) return;

    const newPending: PendingAsset[] = [];
    for (const file of supported) {
      newPending.push(await buildPendingAsset(file));
    }

    setPending((prev) => [...prev, ...newPending]);
  }, []);

  /**
   * Fetch a pasted URL into a staged asset (spec 28 A). The row appears immediately
   * in a loading state and resolves in place, so a slow or failing fetch is always
   * visible rather than a silent no-op.
   */
  const addUrl = useCallback(async (url: string) => {
    const id = crypto.randomUUID();
    setPending((prev) => [
      ...prev,
      { id, status: "loading", name: url, sourceUrl: url },
    ]);

    try {
      const file = await fetchAssetFromUrl(url);
      const staged = await buildPendingAsset(file);
      setPending((prev) =>
        prev.map((p) => (p.id === id ? { ...staged, id, sourceUrl: url } : p))
      );
    } catch (err) {
      const message =
        err instanceof AssetFetchError
          ? err.message
          : "Couldn't load that link.";
      setPending((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, status: "error", error: message } : p
        )
      );
    }
  }, []);

  // Paste handler: image data (as before), or a URL string (spec 28 A).
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;

      // Read everything off the clipboard SYNCHRONOUSLY — clipboardData is dead
      // once this handler yields.
      const imageFiles: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      const text = dt.getData("text/plain");

      // A2: copying an image out of a web page puts BOTH the bitmap and some text on
      // the clipboard. The real image always wins, so we never double-add it.
      if (imageFiles.length > 0) {
        e.preventDefault();
        void addFiles(imageFiles);
        return;
      }

      const urls = text.split(/\s+/).filter(isFetchableUrl);
      // A11: pasted text that isn't a link is ignored silently — people paste by accident.
      if (urls.length === 0) return;
      e.preventDefault();
      for (const url of urls) void addUrl(url);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addFiles, addUrl]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      addFiles(Array.from(e.target.files));
      e.target.value = "";
    },
    [addFiles]
  );

  const removeItem = useCallback((id: string) => {
    setPending((prev) => {
      const item = prev.find((p) => p.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      pendingRef.current.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      });
    };
  }, []);

  const handleImport = useCallback(async () => {
    // Loading/error rows are never imported — only rows whose bytes actually arrived.
    const ready = pending.filter((p) => p.status === "ready" && p.file);
    if (ready.length === 0 || importing) return;
    setImporting(true);

    // Check total size
    const newTotalSize =
      getTotalAssetSize() + ready.reduce((sum, p) => sum + p.file!.size, 0);
    if (newTotalSize > SIZE_WARN_TOTAL) {
      const proceed = window.confirm(
        `Total asset size will exceed ${(SIZE_WARN_TOTAL / 1024 / 1024).toFixed(0)} MB. This may cause performance issues. Continue?`
      );
      if (!proceed) {
        setImporting(false);
        return;
      }
    }

    const newObjects: TimelineObject[] = [];
    const newAssets: AssetMeta[] = [];
    let timeOffset = 0;

    for (const item of ready) {
      const file = item.file!;
      // The animation probe already ran while staging — pass it through so storeAsset
      // records the timings without decoding the whole thing a second time.
      const { meta } = await storeAsset(file, item.animation);

      // Set duration on meta for audio/video (storeAsset already set it for animated images)
      if (item.duration != null && item.type !== "image") {
        meta.duration = item.duration;
      }

      newAssets.push(meta);
      const baseName = item.name.replace(/\.[^.]+$/, "");

      if (item.type === "image") {
        // Animated images (spec 28 B4) default to exactly one loop; stills keep 5s.
        const animation = item.animation;
        const data: PhotoData = animation?.animated
          ? {
              assetId: meta.id,
              animated: true,
              animationDuration: animation.duration,
            }
          : { assetId: meta.id };
        const duration = animation?.animated ? animation.duration : 5;
        newObjects.push(
          createTimelineObject("photo", data, {
            startTime: insertAtTime + timeOffset,
            duration,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            name: baseName,
          })
        );
        // Images do NOT advance the stagger: several photos imported together land on
        // separate lanes (assigned in App.addObjects) but share a start time, so they
        // stack as layers rather than playing as a slideshow. Audio/video still stagger.
      } else if (item.type === "audio") {
        const duration = item.duration ?? 5;
        let waveform: number[] | undefined;
        try {
          waveform = await generateWaveform(file);
        } catch {
          // waveform generation failed, continue without it
        }
        newObjects.push(
          createTimelineObject(
            "audio",
            {
              assetId: meta.id,
              volume: 1,
              originalDuration: duration,
              waveform,
              sourceIn: 0,
              sourceOut: duration,
            },
            {
              startTime: insertAtTime + timeOffset,
              duration,
              name: baseName,
            }
          )
        );
        timeOffset += duration;
      } else if (item.type === "video") {
        const duration = item.duration ?? 5;
        // Decode the video's audio track for a timeline waveform (Chromium decodes audio from mp4/
        // webm containers). Silent videos / unsupported audio simply fall through with no waveform.
        let waveform: number[] | undefined;
        try {
          waveform = await generateWaveform(file);
        } catch {
          // no audio track or decode failed — continue without a waveform
        }
        newObjects.push(
          createTimelineObject(
            "video",
            {
              assetId: meta.id,
              volume: 1,
              originalDuration: duration,
              waveform,
              sourceIn: 0,
              sourceOut: duration,
            },
            {
              startTime: insertAtTime + timeOffset,
              duration,
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              name: baseName,
            }
          )
        );
        timeOffset += duration;
      }
    }

    onAssetsAdded?.(newAssets);
    onImport(newObjects);
    onClose();
  }, [pending, importing, insertAtTime, onImport, onClose, onAssetsAdded]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const readyItems = pending.filter((p) => p.status === "ready");
  const anyLoading = pending.some((p) => p.status === "loading");
  const imageCount = readyItems.filter((p) => p.type === "image").length;
  const audioCount = readyItems.filter((p) => p.type === "audio").length;
  const videoCount = readyItems.filter((p) => p.type === "video").length;

  const summary = [
    imageCount > 0 ? `${imageCount} image${imageCount !== 1 ? "s" : ""}` : "",
    audioCount > 0 ? `${audioCount} audio` : "",
    videoCount > 0 ? `${videoCount} video` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl w-[640px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-bold text-fg">Add Assets</h2>
          <button
            onClick={onClose}
            className="flex items-center text-muted hover:text-fg cursor-pointer"
          >
            <IconX size={20} stroke={2} />
          </button>
        </div>

        {/* Drop zone */}
        <div className="p-4">
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-accent bg-accent-soft"
                : "border-border-strong hover:border-border-strong hover:bg-surface-hover"
            }`}
          >
            <p className="text-muted text-sm font-medium mb-1">
              Drag &amp; drop files here, or click to browse
            </p>
            <p className="text-muted text-xs mb-1">
              You can also paste (Ctrl+V) an image — or a link to one
            </p>
            <p className="text-subtle text-xs">
              Images (PNG, JPG, WebP, GIF) · Audio (MP3, WAV, OGG) · Video (MP4,
              WebM, MOV)
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,audio/*,video/*"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Pending items */}
        {pending.length > 0 && (
          <div className="flex-1 overflow-y-auto px-4 pb-2">
            <p className="text-xs text-muted mb-2">
              {anyLoading && readyItems.length === 0
                ? "Loading…"
                : `${summary} ready to import`}
            </p>
            <div className="space-y-1.5">
              {pending.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 bg-surface-muted rounded p-2 group"
                >
                  {/* Preview / icon */}
                  <div className="w-12 h-12 rounded bg-surface-hover flex items-center justify-center shrink-0 overflow-hidden">
                    {item.status === "loading" ? (
                      <span className="w-5 h-5 rounded-full border-2 border-border-strong border-t-accent animate-spin" />
                    ) : item.status === "error" ? (
                      <span className="text-danger">
                        <IconAlertTriangle size={20} stroke={2} />
                      </span>
                    ) : item.type === "image" && item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt={item.name}
                        className="w-full h-full object-cover"
                      />
                    ) : item.type === "video" && item.previewUrl ? (
                      <video
                        src={item.previewUrl}
                        className="w-full h-full object-cover"
                        muted
                      />
                    ) : item.type === "audio" ? (
                      <span className="text-lg">♪</span>
                    ) : (
                      <span className="text-lg">▶</span>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg truncate">{item.name}</p>
                    {item.status === "error" ? (
                      <p className="text-xs text-danger">{item.error}</p>
                    ) : item.status === "loading" ? (
                      <p className="text-xs text-subtle">Loading from link…</p>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-subtle">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                            item.type === "image"
                              ? "bg-blue-100 text-blue-700"
                              : item.type === "audio"
                                ? "bg-teal-100 text-teal-700"
                                : "bg-violet-100 text-violet-700"
                          }`}
                        >
                          {item.type}
                        </span>
                        {item.animation?.animated && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase bg-amber-100 text-amber-700">
                            animated
                          </span>
                        )}
                        {item.sourceUrl && (
                          <span
                            className="text-subtle"
                            title={item.sourceUrl}
                          >
                            <IconLink size={12} stroke={2} />
                          </span>
                        )}
                        {item.duration != null && (
                          <span>{item.duration.toFixed(1)}s</span>
                        )}
                        {item.file && (
                          <span>
                            {(item.file.size / 1024 / 1024).toFixed(1)} MB
                          </span>
                        )}
                        {item.sizeWarning && (
                          <span className="text-amber-600">
                            {item.sizeWarning}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => removeItem(item.id)}
                    className={`w-6 h-6 flex items-center justify-center text-subtle hover:text-danger transition-opacity cursor-pointer ${
                      item.status === "error"
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <IconX size={16} stroke={2} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-surface-muted hover:bg-surface-hover text-fg rounded transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={readyItems.length === 0 || importing || anyLoading}
            className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-accent-contrast font-medium rounded transition-colors cursor-pointer"
          >
            {importing
              ? "Importing..."
              : anyLoading
                ? "Loading..."
                : readyItems.length > 0
                  ? `Import ${summary}`
                  : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
