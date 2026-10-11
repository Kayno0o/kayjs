import type { KayExtension } from 'kay/server'
import type { CmsOptions } from './settings'
import { configure } from './settings'

// The API path the editor and the screens call, under `/api`.
export const API_PREFIX = 'cms'

// The one line an app adds to kay.config.ts. `editor` is the island kay renders at the end of the page in edit mode only, as agreed in kaynooo/kayjs#262; kay's KayExtension types it once it ships.
export function cms(options: CmsOptions = {}): KayExtension & { editor: string } {
  const { prefix } = configure(options)

  return {
    name: '@kaynooo/kayjs-cms',
    routes: { dir: `${import.meta.dir}/routes`, prefix },
    api: { dir: `${import.meta.dir}/api`, prefix: API_PREFIX },
    editor: `${import.meta.dir}/editor/editor.kay`,
  }
}
