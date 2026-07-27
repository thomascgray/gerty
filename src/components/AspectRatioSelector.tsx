import { useState, useRef, useEffect } from "react";
import type { ProjectAction } from "../types";
import {
  ASPECT_PRESETS,
  GROUP_LABELS,
  MIN_DIMENSION,
  MAX_DIMENSION,
  matchPreset,
  formatRatio,
  sanitizeDimension,
  type AspectGroup,
  type AspectPreset,
} from "../lib/aspectRatios";

type AspectRatioSelectorProps = {
  width: number;
  height: number;
  dispatch: React.Dispatch<ProjectAction>;
};

/** A little rectangle drawn at the preset's true proportions, sized to fit within a box. */
function RatioGlyph({
  width,
  height,
  active,
}: {
  width: number;
  height: number;
  active?: boolean;
}) {
  const max = 18;
  const w = width >= height ? max : Math.round((width / height) * max);
  const h = height >= width ? max : Math.round((height / width) * max);
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 shrink-0">
      <span
        className={`block rounded-xs border ${active ? "border-accent bg-accent-soft" : "border-border-strong"}`}
        style={{ width: w, height: h }}
      />
    </span>
  );
}

const GROUP_ORDER: AspectGroup[] = ["standard", "social"];

export default function AspectRatioSelector({
  width,
  height,
  dispatch,
}: AspectRatioSelectorProps) {
  const [open, setOpen] = useState(false);
  const [customW, setCustomW] = useState(String(width));
  const [customH, setCustomH] = useState(String(height));
  const rootRef = useRef<HTMLDivElement>(null);

  const active = matchPreset(width, height);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Toggle the menu; seed the custom fields from the current project dims each time it opens.
  const toggle = () => {
    const next = !open;
    if (next) {
      setCustomW(String(width));
      setCustomH(String(height));
    }
    setOpen(next);
  };

  const applyPreset = (p: AspectPreset) => {
    dispatch({ type: "SET_DIMENSIONS", width: p.width, height: p.height });
    setOpen(false);
  };

  const applyCustom = () => {
    const w = sanitizeDimension(Number(customW));
    const h = sanitizeDimension(Number(customH));
    dispatch({ type: "SET_DIMENSIONS", width: w, height: h });
    setCustomW(String(w));
    setCustomH(String(h));
    setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={toggle}
        title="Canvas size / aspect ratio"
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-fg bg-surface-muted hover:bg-surface-hover rounded transition-colors cursor-pointer"
      >
        <RatioGlyph width={width} height={height} />
        <span className="font-medium tabular-nums">
          {active ? active.ratio : formatRatio(width, height)}
        </span>
        <svg width="8" height="8" viewBox="0 0 10 6" className="text-subtle">
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-surface border border-border rounded-lg shadow-xl z-50 py-1.5">
          {GROUP_ORDER.map((group) => (
            <div key={group}>
              <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-subtle">
                {GROUP_LABELS[group]}
              </div>
              {ASPECT_PRESETS.filter((p) => p.group === group).map((p) => {
                const isActive = active?.id === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p)}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                      isActive ? "bg-accent-soft" : "hover:bg-surface-hover"
                    }`}
                  >
                    <RatioGlyph
                      width={p.width}
                      height={p.height}
                      active={isActive}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-baseline gap-1.5">
                        <span
                          className={`text-xs font-medium ${isActive ? "text-accent" : "text-fg"}`}
                        >
                          {p.label}
                        </span>
                        <span className="text-[10px] text-subtle tabular-nums">
                          {p.ratio}
                        </span>
                      </span>
                      {p.hint && (
                        <span className="block text-[10px] text-subtle truncate">
                          {p.hint}
                        </span>
                      )}
                    </span>
                    {isActive && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        className="text-accent shrink-0"
                      >
                        <path
                          d="M2 6l3 3 5-6"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          fill="none"
                        />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {/* Custom entry */}
          <div className="border-t border-border mt-1 pt-2 px-3 pb-1">
            <div className="text-[9px] uppercase tracking-wider text-subtle mb-1.5">
              Custom
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={customW}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                onChange={(e) => setCustomW(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustom();
                }}
                className="w-full bg-surface-muted text-fg text-xs px-2 py-1 rounded border border-border focus:border-accent outline-none tabular-nums"
                aria-label="Custom width"
              />
              <span className="text-subtle text-xs">×</span>
              <input
                type="number"
                value={customH}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                onChange={(e) => setCustomH(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustom();
                }}
                className="w-full bg-surface-muted text-fg text-xs px-2 py-1 rounded border border-border focus:border-accent outline-none tabular-nums"
                aria-label="Custom height"
              />
              <button
                onClick={applyCustom}
                className="px-2.5 py-1 text-xs bg-accent hover:bg-accent-hover text-accent-contrast rounded transition-colors cursor-pointer shrink-0"
              >
                Set
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
