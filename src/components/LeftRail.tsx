import { useState, type ComponentType } from 'react'
import type { TimelineObjectType, AssetMeta } from '../types'
import { getAssetUrl } from '../lib/assetStore'
import { EFFECT_PRESETS } from '../lib/effectPresets'
import {
  IconPhoto, IconTypography, IconShape, IconZoomScan,
  IconArrowUpRight, IconScribble, IconPhotoPlus, IconMusic, IconSquare, IconCircle, IconWaveSine, IconMicrophone, IconBadgeCc,
  IconChevronLeft, IconChevronRight, IconFilters,
  IconContrast, IconMovie, IconDeviceTv, IconBrush,
  IconPrism, IconSkull, IconSunset2, IconBinoculars, IconVideo, IconMoon,
  type IconProps,
} from '@tabler/icons-react'

type TablerIcon = ComponentType<IconProps>
type RailSection = 'media' | 'text' | 'elements' | 'effects'

type LeftRailProps = {
  assets: AssetMeta[]
  onAddMedia: () => void                    // open the import flow (modal)
  onAddAsset: (assetId: string) => void     // re-add an already-imported asset
  onCreateTTS: () => void                   // spec 32: open the text-to-speech modal
  onRecord: () => void                      // spec 34: open the microphone recording modal
  onCreateCaptions: () => void              // spec 35: open the auto-captions modal
  onCreateObject: (type: TimelineObjectType) => void
  onCreateZoom: () => void
  onCreateEffect: () => void                       // spec 37: create an (empty) Full screen effect stack
  onApplyPreset: (presetId: string) => void        // spec 26: apply a named preset stack
}

// Per-preset icon (kept here so effectPresets.ts stays free of React imports).
const PRESET_ICON: Record<string, TablerIcon> = {
  cinematic: IconVideo,
  cinematiccool: IconMoon,
  super8: IconMovie,
  retrotv: IconDeviceTv,
  noir: IconContrast,
  comicbook: IconBrush,
  grimdark: IconSkull,
  vaporwave: IconSunset2,
  nightvision: IconBinoculars,
}

const SECTIONS: { id: RailSection; label: string; Icon: TablerIcon }[] = [
  { id: 'media', label: 'Media', Icon: IconPhoto },
  { id: 'text', label: 'Text', Icon: IconTypography },
  { id: 'elements', label: 'Elements', Icon: IconShape },
  { id: 'effects', label: 'Effects', Icon: IconFilters },
]

/**
 * Left creation + asset rail (spec 17 L): a vertical icon rail of sections + a content pane.
 * Subsumes the old header creation clusters and the "+ Asset" trigger, and adds a basic re-addable
 * media library. Collapsible to just the icon rail. Ephemeral view-state (not persisted).
 */
export default function LeftRail({ assets, onAddMedia, onAddAsset, onCreateTTS, onRecord, onCreateCaptions, onCreateObject, onCreateZoom, onCreateEffect, onApplyPreset }: LeftRailProps) {
  const [section, setSection] = useState<RailSection>('media')
  const [open, setOpen] = useState(true)

  const selectSection = (s: RailSection) => {
    if (s === section && open) setOpen(false)   // click the active section to collapse
    else { setSection(s); setOpen(true) }
  }

  return (
    <div className="flex h-full shrink-0 bg-surface border-r border-border">
      {/* Icon rail — sits above the pane (z-10) so the active caret can bridge onto the seam. */}
      <div className="relative z-10 flex flex-col items-center w-13 py-2 border-r border-border shrink-0">
        {SECTIONS.map(({ id, label, Icon }) => {
          const active = section === id && open
          return (
            <button
              key={id}
              onClick={() => selectSection(id)}
              title={label}
              className={`relative flex flex-col items-center gap-0.5 w-full py-2 text-[9px] cursor-pointer transition-colors ${
                active ? 'text-accent' : 'text-muted hover:text-fg'
              }`}
            >
              {active && (
                <>
                  {/* Filled surface + left bar tie the icon to its (open) pane; the caret on the
                      rail↔pane seam points at the sub-options, so category & options read as one unit. */}
                  <span className="absolute inset-y-1 left-1.5 right-0 rounded-l-md bg-accent-soft" />
                  <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-accent" />
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full h-0 w-0 border-y-[5px] border-y-transparent border-l-[6px] border-l-accent" />
                </>
              )}
              <span className="relative z-10 flex flex-col items-center gap-0.5">
                <Icon size={20} stroke={1.8} />
                {label}
              </span>
            </button>
          )
        })}
        <button
          onClick={() => setOpen((o) => !o)}
          title={open ? 'Collapse panel' : 'Expand panel'}
          className="mt-auto flex items-center justify-center w-full py-2 text-subtle hover:text-fg cursor-pointer transition-colors"
        >
          {open ? <IconChevronLeft size={16} stroke={2} /> : <IconChevronRight size={16} stroke={2} />}
        </button>
      </div>

      {/* Content pane — always mounted and width-animated so collapse/expand slides rather than
          snapping. Outer clips; inner keeps its fixed width so content doesn't reflow mid-slide. */}
      <div className={`h-full overflow-hidden transition-[width] duration-200 ease-out ${open ? 'w-52' : 'w-0'}`}>
        <div className="w-52 h-full flex flex-col min-h-0 shrink-0">
          {section === 'media' && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <MediaSection assets={assets} onAddMedia={onAddMedia} onAddAsset={onAddAsset} onCreateTTS={onCreateTTS} onRecord={onRecord} onCreateCaptions={onCreateCaptions} />
            </div>
          )}
          {section === 'text' && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SimpleSection title="Text" items={[
                { label: 'Add text box', Icon: IconTypography, onClick: () => onCreateObject('text') },
              ]} />
            </div>
          )}
          {section === 'elements' && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SimpleSection title="Elements" items={[
                { label: 'Pen', Icon: IconScribble, onClick: () => onCreateObject('freehand') },
                { label: 'Arrow', Icon: IconArrowUpRight, onClick: () => onCreateObject('arrow') },
                { label: 'Rectangle', Icon: IconSquare, onClick: () => onCreateObject('rectangle') },
                { label: 'Circle', Icon: IconCircle, onClick: () => onCreateObject('circle') },
              ]} />
            </div>
          )}
          {section === 'effects' && (
            <div className="flex flex-col flex-1 min-h-0">
            {/* Raw effects: own scroll area, capped to ~half so Presets stay visible below. */}
            <div className="flex-1 min-h-0 overflow-y-auto">
            {/* spec 37: the 22 per-kind effects collapse into ONE "Full screen effect" — a stack you
                build up in the panel. Presets below drop a ready-made stack. */}
            <SimpleSection title="Effects" items={[
              { label: 'Camera zoom', Icon: IconZoomScan, onClick: onCreateZoom },
              { label: 'Full screen effect', Icon: IconFilters, onClick: onCreateEffect },
            ]} />
            </div>
            {/* Presets: always-visible lower half, own scroll for overflow. */}
            <div className="flex-1 min-h-0 overflow-y-auto border-t border-border">
            <SimpleSection title="Presets" items={EFFECT_PRESETS.map((p) => ({
              label: p.name,
              Icon: PRESET_ICON[p.id] ?? IconPrism,
              title: p.description,
              onClick: () => onApplyPreset(p.id),
            }))} />
            </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MediaSection({ assets, onAddMedia, onAddAsset, onCreateTTS, onRecord, onCreateCaptions }: {
  assets: AssetMeta[]
  onAddMedia: () => void
  onAddAsset: (assetId: string) => void
  onCreateTTS: () => void
  onRecord: () => void
  onCreateCaptions: () => void
}) {
  // Recording needs a secure context + getUserMedia + MediaRecorder; disable the entry point cleanly
  // rather than opening a modal that can only fail (spec 34 R6).
  const canRecord =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'

  return (
    <div className="p-3 flex flex-col gap-3">
      <button
        onClick={onAddMedia}
        className="flex items-center justify-center gap-1.5 w-full py-2 text-sm font-medium bg-accent text-accent-contrast rounded-lg hover:bg-accent-hover cursor-pointer transition-colors"
      >
        <IconPhotoPlus size={16} stroke={2} /> Add media
      </button>

      <button
        onClick={onCreateTTS}
        title="Generate narration from text (in-browser text to speech)"
        className="flex items-center justify-center gap-1.5 w-full py-2 text-sm font-medium bg-surface-muted text-fg border border-border rounded-lg hover:bg-surface-hover cursor-pointer transition-colors"
      >
        <IconWaveSine size={16} stroke={2} /> Text to speech
      </button>

      <button
        onClick={canRecord ? onRecord : undefined}
        disabled={!canRecord}
        title={canRecord ? 'Record a voiceover from your microphone' : 'Recording needs a secure page (HTTPS or localhost) and microphone support'}
        className="flex items-center justify-center gap-1.5 w-full py-2 text-sm font-medium bg-surface-muted text-fg border border-border rounded-lg hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        <IconMicrophone size={16} stroke={2} /> Record voiceover
      </button>

      <button
        onClick={onCreateCaptions}
        title="Auto-generate subtitles from the timeline's speech (in-browser speech recognition)"
        className="flex items-center justify-center gap-1.5 w-full py-2 text-sm font-medium bg-surface-muted text-fg border border-border rounded-lg hover:bg-surface-hover cursor-pointer transition-colors"
      >
        <IconBadgeCc size={16} stroke={2} /> Auto captions
      </button>

      {assets.length === 0 ? (
        <p className="text-[11px] text-subtle text-center px-2 py-4 leading-relaxed">
          Imported media appears here — click to reuse it anywhere on the timeline.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {assets.map((a) => (
            <AssetThumb key={a.id} asset={a} onClick={() => onAddAsset(a.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function AssetThumb({ asset, onClick }: { asset: AssetMeta; onClick: () => void }) {
  const url = asset.type !== 'audio' ? getAssetUrl(asset.id) : undefined
  return (
    <button
      onClick={onClick}
      title={`Add ${asset.filename}`}
      className="group relative aspect-square rounded-md overflow-hidden bg-surface-muted border border-border hover:border-accent cursor-pointer transition-colors"
    >
      {asset.type === 'image' && url ? (
        <img src={url} alt={asset.filename} className="w-full h-full object-cover" />
      ) : asset.type === 'video' && url ? (
        <video src={url} className="w-full h-full object-cover" muted />
      ) : (
        <span className="w-full h-full flex items-center justify-center text-subtle">
          <IconMusic size={22} stroke={1.8} />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[9px] text-white bg-black/55 truncate text-left">
        {asset.filename}
      </span>
    </button>
  )
}

function SimpleSection({ title, items }: {
  title: string
  items: { label: string; Icon: TablerIcon; onClick: () => void; title?: string }[]
}) {
  return (
    <div className="p-3">
      <h3 className="text-[10px] font-semibold text-subtle uppercase tracking-wider mb-2 px-1">{title}</h3>
      <div className="flex flex-col gap-1.5">
        {items.map(({ label, Icon, onClick, title: tip }) => (
          <button
            key={label}
            onClick={onClick}
            title={tip}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-fg bg-surface-muted hover:bg-surface-hover rounded-lg cursor-pointer transition-colors"
          >
            <Icon size={18} stroke={1.8} /> {label}
          </button>
        ))}
      </div>
    </div>
  )
}
