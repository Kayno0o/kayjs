import type { KayExtension } from 'kay/server'
import type { FileSaver } from './files'
import type { CmsOptions } from './settings'
import { s } from 'kay'
import { configError, serverRoot, underKayDev } from 'kay/library'
import { api, defineEnv } from 'kay/server'
import { forgejo } from './files'
import { collectionInfo, collections } from './kay/content'
import { hintProblems, missingKindLines } from './kinds'
import { bodylessLayout, layoutProblems, whenProblems } from './layout'
import { log } from './log'
import { migrateUploads } from './migrate-uploads'
import { pageLinkLoader } from './page-link'
import { configure, settings } from './settings'

// Where the editor and the screens call the API, outside `apiPath` like kay's own files.
export const API_PREFIX = '/_kay/cms'
// Where it was served under `apiPath` before 1.71, still answered through 1.73.
const FORMER_PREFIX = 'cms'

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

// What a production server with no `cms({ files })` commits through, listed for `kay env`.
const CMS_ENV = s.Object({
  CMS_BASE_URL: s.Optional(s.String({ description: 'the Forgejo a production cms commits edits to, such as https://git.example.com, when cms({ files }) is not set' })),
  CMS_REPO: s.Optional(s.String({ description: 'the repository the cms commits to, as owner/name' })),
  CMS_TOKEN: s.Optional(s.String({ description: 'a Forgejo token allowed to write that repository\'s contents' })),
  CMS_BRANCH: s.Optional(s.String({ description: 'the branch the cms commits to, the repository\'s default when unset' })),
})

const NO_SAVER = 'a production server saves no edit to the working tree, which the next deploy replaces: set CMS_BASE_URL, CMS_REPO and CMS_TOKEN for a Forgejo, or cms({ files: forgejo(...) }), or cms({ files: workingTree() }) where the files outlive a deploy'

// The Forgejo the environment names, for a production server given no `files`; with none of it set, or part of it, the boot stops naming what is missing.
function savedFromEnv(): FileSaver {
  const { CMS_BASE_URL: baseUrl, CMS_REPO: repo, CMS_TOKEN: token, CMS_BRANCH: branch } = defineEnv(CMS_ENV)

  if (baseUrl === undefined && repo === undefined && token === undefined)
    throw configError(NO_SAVER)

  const missing = Object.entries({ CMS_BASE_URL: baseUrl, CMS_REPO: repo, CMS_TOKEN: token }).filter(([, value]) => value === undefined).map(([name]) => name)

  if (baseUrl === undefined || repo === undefined || token === undefined)
    throw configError(`the cms commits to the Forgejo the environment names, which lacks ${missing.join(' and ')}`)

  return forgejo({ baseUrl, repo, token, branch })
}

const UNCHECKED = 'the collections could not be checked for field kinds with no component or a layout naming a field they lack, or a `when` waiting for none'

// The one line an app adds to kay.config.ts. `editor` is the island kay renders at the end of every page in edit mode only.
export function cms(options: CmsOptions = {}): KayExtension {
  const { prefix } = configure(options)

  return {
    name: '@kaynooo/kayjs-cms',
    routes: { dir: `${import.meta.dir}/routes`, prefix: prefix === '/' ? ROOT_MOUNT : prefix },
    api: { dir: `${import.meta.dir}/api`, prefix: API_PREFIX, former: FORMER_PREFIX },
    editor: `${import.meta.dir}/editor/editor.kay`,
    // An editor's browser, marked once the guard let it into the screens, finds an "Edit this page" link on the pages it reads; any other browser loads nothing more than this line.
    ...options.pageLink !== false && { config: { head: [{ tag: 'script', props: { children: pageLinkLoader() } }] } },
    devTool: { module: `${import.meta.dir}/devTool.ts` },
    env: CMS_ENV,
    // What the server logs or stops at as it listens, for `kay check` and the editor to show without one.
    check: async () => {
      // A collection loader that fails is a warning, as the boot logs it, not an error of the check; it hides a bodyless-layout error that was to be found beside it.
      try {
        const stop = await bodyProblem()

        return [...stop === undefined ? [] : [{ message: stop, severity: 'error' as const }], ...(await setupWarnings()).map(message => ({ message }))]
      }
      catch (error) {
        return [{ message: `${UNCHECKED}: ${error instanceof Error ? error.message : String(error)}` }]
      }
    },
    // Run as the server boots, never by `kay build` or `kay check`.
    server: () => {
      if (options.files === undefined && process.env.NODE_ENV === 'production')
        settings().files = savedFromEnv()

      if (options.guard === undefined && options.role === undefined && !underKayDev())
        log.warn('no cms({ guard }): outside `kay dev` an edit link or cookie reads only the entries of the pages it opens and saves, publishes, deletes and uploads nothing, and the admin screens stay closed; set cms({ role }) or cms({ guard }) to let editors write')

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
          log.warn(UNCHECKED, error)
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
