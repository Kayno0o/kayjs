import type { KayExtension } from 'kay/server'

// The API path the editor calls, under `/api`.
export const API_PREFIX = 'cms'

// `editor` is the island kay renders at the end of the page in edit mode only, as agreed in kaynooo/kayjs#262; kay's KayExtension types it once it ships.
export function cms(): KayExtension & { editor: string } {
  return {
    name: '@kaynooo/kayjs-cms',
    api: { dir: `${import.meta.dir}/api`, prefix: API_PREFIX },
    editor: `${import.meta.dir}/editor/editor.kay`,
  }
}
