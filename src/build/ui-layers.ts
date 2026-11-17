import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

// The files extensions contribute `defineUi` entries from, by project root, in the order of the config; set as the config loads. Kept apart from `ui.ts`, which reads them with the compiler, so the config loader a compiled server runs stays free of it.
const layerFiles = new Map<string, string[]>()

// A project's root as the layers are filed under it: through a symlink or not, it is one project.
function rootKey(root: string): string {
  try {
    return realpathSync(root)
  }
  catch {
    return resolve(root)
  }
}

// The files of the layers of a project, in config order.
export function layerFilesOf(root: string): string[] {
  return layerFiles.get(rootKey(root)) ?? []
}

// Records the `ui` files of the extensions for a project: absolute, or relative to its root.
export function setUiLayers(root: string, extensions: readonly { ui?: string | undefined }[] | undefined): void {
  const files = (extensions ?? []).flatMap(({ ui }) => ui === undefined ? [] : [resolve(root, ui)])

  if (files.length === 0)
    layerFiles.delete(rootKey(root))
  else
    layerFiles.set(rootKey(root), files)
}
