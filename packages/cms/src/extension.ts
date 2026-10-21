import type { KayExtension } from 'kay/server'
import type { CmsOptions } from './settings'
import { configError, serverRoot, underKayDev } from 'kay/library'
import { api } from 'kay/server'
import { collectionInfo, collections } from './kay/content'
import { hintProblems, missingKindLines } from './kinds'
import { bodylessLayout, layoutProblems, whenProblems } from './layout'
import { log } from './log'
import { migrateUploads } from './migrate-uploads'
import { pageLinkLoader } from './page-link'
import { configure, settings } from './settings'

// The API path the editor and the screens call, under `/api`.
export const API_PREFIX = 'cms'

// Where a cms at the root prefix mounts its screens: a group, which adds nothing to a URL but keeps the screens' layout and guard from being the app's own at the top of the routes, where an app root layout would win over the cms's and the cms's would wrap and guard every page of the app.
const ROOT_MOUNT = '/(admin)'

// A body worded on a collection with none is a mistake to fix, so it stops the boot rather than logging; only the collections wording one are read for their body, as a loader runs for it.
async function bodyProblem(): Promise<string | undefined> {
  const worded = [...settings().layouts].filter(([, layout]) => layout.form?.body !== undefined).map(([name]) => name)

  return bodylessLayout((await Promise.all(worded.map(async name => collectionInfo(name)))).filter(found => found !== undefined), settings().layouts)
}

// The lines naming a collection and a field path that the editor would misshow: a kind with no component, a hint or layout naming what the schema lacks, a `when` waiting for none.
async function setupWarnings(): Promise<string[]> {
  const listed = await collections({ counts: false })

  return [...hintProblems(listed), ...missingKindLines(await serverRoot(), listed), ...layoutProblems(listed, settings().layouts), ...whenProblems(listed)]
}

// The one line an app adds to kay.config.ts. `editor` is the island kay renders at the end of every page in edit mode only.
export function cms(options: CmsOptions = {}): KayExtension {
  const { prefix } = configure(options)

  return {
    name: '@kaynooo/kayjs-cms',
    routes: { dir: `${import.meta.dir}/routes`, prefix: prefix === '/' ? ROOT_MOUNT : prefix },
    api: { dir: `${import.meta.dir}/api`, prefix: API_PREFIX },
    editor: `${import.meta.dir}/editor/editor.kay`,
    // An editor's browser, marked once the guard let it into the screens, finds an "Edit this page" link on the pages it reads; any other browser loads nothing more than this line.
    ...options.pageLink !== false && { config: { head: [{ tag: 'script', props: { children: pageLinkLoader() } }] } },
    devTool: { module: `${import.meta.dir}/devTool.ts` },
    // What the server logs or stops at as it listens, for `kay check` and the editor to show without one.
    check: async () => {
      const stop = await bodyProblem()

      return [...stop === undefined ? [] : [{ message: stop, severity: 'error' as const }], ...(await setupWarnings()).map(message => ({ message }))]
    },
    // Run as the server boots, never by `kay build` or `kay check`.
    server: () => {
      if (options.files === undefined && process.env.NODE_ENV === 'production')
        throw configError('a production server saves no edit to the working tree, which the next deploy replaces: set cms({ files: forgejo(...) }), or cms({ files: workingTree() }) where the files outlive a deploy')

      if (options.guard === undefined && !underKayDev())
        log.warn('no cms({ guard }): outside `kay dev` an edit link or cookie reads only the entries of the pages it opens and saves, publishes, deletes and uploads nothing, and the admin screens stay closed; set cms({ guard }) to let editors write')

      const plugin = api()

      // Once the server listens, the content config is registered.
      plugin.onStart(async () => {
        const problem = await bodyProblem()

        // A throw here would be an unhandled rejection of a hook nobody awaits, leaving the server up, so the process ends itself.
        if (problem !== undefined) {
          log.error(problem)
          process.exit(1)
        }

        try {
          for (const line of await setupWarnings())
            log.warn(line)
        }
        catch (error) {
          log.warn('the collections could not be checked for field kinds with no component or a layout naming a field they lack, or a `when` waiting for none', error)
        }

        // Uploads an older release kept in a folder per collection move to the shared folder, once and without the app asking.
        try {
          const { moved, pending } = await migrateUploads()

          if (moved > 0 || pending > 0)
            log.info(`${moved} older uploads moved to the shared folder${pending > 0 ? `, ${pending} waiting for an entry that could not be saved` : ''}`)
        }
        catch (error) {
          log.warn('the older uploads could not be moved to the shared folder', error)
        }
      })

      return plugin
    },
  }
}
