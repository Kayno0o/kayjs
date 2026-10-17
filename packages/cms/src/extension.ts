import type { KayExtension } from 'kay/server'
import type { CmsOptions } from './settings'
import { underKayDev } from 'kay/library'
import { api, editRequested } from 'kay/server'
import { collections } from './kay/content'
import { missingKindLines } from './kinds'
import { log } from './log'
import { configure } from './settings'

// The API path the editor and the screens call, under `/api`.
export const API_PREFIX = 'cms'

// Where `kay dev` answers the dev tool's CMS tab.
const DEV_PATH = '/_kay/cms'

// The one line an app adds to kay.config.ts. `editor` is the island kay renders at the end of every page in edit mode only.
export function cms(options: CmsOptions = {}): KayExtension {
  const { prefix } = configure(options)

  return {
    name: '@kaynooo/kayjs-cms',
    routes: { dir: `${import.meta.dir}/routes`, prefix },
    api: { dir: `${import.meta.dir}/api`, prefix: API_PREFIX },
    editor: `${import.meta.dir}/editor/editor.kay`,
    devTool: { module: `${import.meta.dir}/devTool.ts` },
    // Run as the server boots, never by `kay build` or `kay check`.
    server: () => {
      if (options.files === undefined && process.env.NODE_ENV === 'production')
        throw new Error('kayjs-cms: a production server saves no edit to the working tree, which the next deploy replaces: set cms({ files: forgejo(...) }), or cms({ files: workingTree() }) where the files outlive a deploy')

      const plugin = api()

      // Once the server listens, the content config is registered.
      plugin.onStart(async () => {
        try {
          for (const line of missingKindLines(process.cwd(), await collections({ counts: false })))
            log.warn(line)
        }
        catch {
          // The collections' own errors are the pages' to report.
        }
      })

      if (underKayDev()) {
        plugin.get(DEV_PATH, ({ request, set }) => {
          set.headers['cache-control'] = 'no-store'

          return { editing: editRequested(request), prefix, exit: `/api/${API_PREFIX}/preview/exit` }
        })
      }

      return plugin
    },
  }
}
