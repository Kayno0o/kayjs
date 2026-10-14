import type { KayExtension } from 'kay/server'
import type { CmsOptions } from './settings'
import { api } from 'kay/server'
import { configure } from './settings'

// The API path the editor and the screens call, under `/api`.
export const API_PREFIX = 'cms'

// The one line an app adds to kay.config.ts. `editor` is the island kay renders at the end of every page in edit mode only.
export function cms(options: CmsOptions = {}): KayExtension {
  const { prefix } = configure(options)

  return {
    name: '@kaynooo/kayjs-cms',
    routes: { dir: `${import.meta.dir}/routes`, prefix },
    api: { dir: `${import.meta.dir}/api`, prefix: API_PREFIX },
    editor: `${import.meta.dir}/editor/editor.kay`,
    // Run as the server boots, never by `kay build` or `kay check`.
    server: () => {
      if (options.files === undefined && process.env.NODE_ENV === 'production')
        throw new Error('kayjs-cms: a production server saves no edit to the working tree, which the next deploy replaces: set cms({ files: forgejo(...) }), or cms({ files: workingTree() }) where the files outlive a deploy')

      return api()
    },
  }
}
