import JSZip from 'jszip'
import type { Project } from '../types'
import { createDefaultProject } from '../types'
import { getAssetBlob, storeAssetBlob } from './assetStore'

const STORAGE_KEY = 'gerty-project'

export function saveProject(project: Project): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
  } catch (e) {
    console.warn('Failed to save project to localStorage:', e)
  }
}

export function loadProject(): Project {
  try {
    const data = localStorage.getItem(STORAGE_KEY)
    if (data) {
      const parsed = JSON.parse(data)
      if (parsed.objects && Array.isArray(parsed.objects)) {
        if (!parsed.assets) parsed.assets = []
        return parsed as Project
      }
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch (e) {
    console.warn('Failed to load project from localStorage:', e)
  }
  return createDefaultProject()
}

export function clearProject(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Export project as a .gerty file (ZIP archive containing project.json + assets/).
 */
export async function exportProjectBrep(project: Project): Promise<void> {
  const zip = new JSZip()

  // Add project JSON
  zip.file('project.json', JSON.stringify(project, null, 2))

  // Add all asset blobs
  const assets = zip.folder('assets')!
  for (const asset of project.assets) {
    const blob = getAssetBlob(asset.id)
    if (blob) {
      // Use asset ID + original extension for filename
      const ext = asset.filename.split('.').pop() ?? 'bin'
      assets.file(`${asset.id}.${ext}`, blob)
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.name.replace(/\s+/g, '-').toLowerCase()}.gerty`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Import a .gerty file. Extracts assets into IndexedDB and returns the project.
 */
export async function importProjectBrep(file: File): Promise<Project> {
  const zip = await JSZip.loadAsync(file)

  const projectJson = zip.file('project.json')
  if (!projectJson) throw new Error('Invalid .gerty file: missing project.json')

  const projectText = await projectJson.async('text')
  const project = JSON.parse(projectText) as Project
  if (!project.assets) project.assets = []

  // Extract and store all assets
  const assetsFolder = zip.folder('assets')
  if (assetsFolder) {
    for (const asset of project.assets) {
      // Find the matching file in the assets folder
      const matchingFiles = Object.keys(assetsFolder.files).filter(
        (name) => name.startsWith(`assets/${asset.id}.`)
      )
      if (matchingFiles.length > 0) {
        const assetFile = zip.file(matchingFiles[0])
        if (assetFile) {
          const blob = await assetFile.async('blob')
          await storeAssetBlob(asset.id, blob)
        }
      }
    }
  }

  return project
}
