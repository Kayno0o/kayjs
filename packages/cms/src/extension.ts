import type { KayExtension } from 'kay/server'
import type { CmsOptions } from './settings'
import { serverRoot, underKayDev } from 'kay/library'
import { api, editRequested } from 'kay/server'
import { wording } from 'kay/words'
import { collections } from './kay/content'
import { missingKindLines } from './kinds'
import { layoutProblems, whenProblems } from './layout'
import { log } from './log'
import { pageLinkLoader } from './page-link'
import { configure, settings } from './settings'

// The API path the editor and the screens call, under `/api`.
export const API_PREFIX = 'cms'

// Where a cms at the root prefix mounts its screens: a group, which adds nothing to a URL but keeps the screens' layout and guard from being the app's own at the top of the routes, where an app root layout would win over the cms's and the cms's would wrap and guard every page of the app.
const ROOT_MOUNT = '/(admin)'

// Where `kay dev` answers the dev tool's CMS tab.
const DEV_PATH = '/_kay/cms'

// The texts of the dev tool's tab in the visitor's language, which the browser module cannot look up itself. `{failure}` is filled in there.
function devWords(): Record<string, string> {
  return {
    editing: wording('cms.dev.editing', 'You are in edit mode on this site.'),
    notEditing: wording('cms.dev.notEditing', 'You are not in edit mode.'),
    edit: wording('cms.page.edit', 'Edit this page'),
    leave: wording('cms.dev.leave', 'Leave edit mode'),
    guard: wording('cms.dev.guard', 'The screens\' guard decides whether you may.'),
    screens: wording('cms.dev.screens', 'Open the screens'),
    readFailure: wording('cms.dev.readFailure', 'Could not read the edit mode: {failure}', { failure: '{failure}' }),
    leaveFailure: wording('cms.dev.leaveFailure', 'Could not leave edit mode: {failure}', { failure: '{failure}' }),
    unavailable: wording('cms.dev.unavailable', 'kayjs-cms answers here under `kay dev` alone.'),
    answered: wording('cms.dev.answered', 'the server answered {status}', { status: '{status}' }),
  }
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
    // Run as the server boots, never by `kay build` or `kay check`.
    server: () => {
      if (options.files === undefined && process.env.NODE_ENV === 'production')
        throw new Error('kayjs-cms: a production server saves no edit to the working tree, which the next deploy replaces: set cms({ files: forgejo(...) }), or cms({ files: workingTree() }) where the files outlive a deploy')

      if (options.guard === undefined && !underKayDev())
        log.warn('no cms({ guard }): outside `kay dev` an edit link or cookie reads only the entries of the pages it opens and saves, publishes, deletes and uploads nothing, and the admin screens stay closed; set cms({ guard }) to let editors write')

      const plugin = api()

      // Once the server listens, the content config is registered.
      plugin.onStart(async () => {
        try {
          const listed = await collections({ counts: false })

          for (const line of [...missingKindLines(await serverRoot(), listed), ...layoutProblems(listed, settings().layouts), ...whenProblems(listed)])
            log.warn(line)
        }
        catch (error) {
          log.warn('the collections could not be checked for field kinds with no component or a layout naming a field they lack, or a `when` waiting for none', error)
        }
      })

      if (underKayDev()) {
        plugin.get(DEV_PATH, ({ request, set }) => {
          set.headers['cache-control'] = 'no-store'

          return { editing: editRequested(request), prefix, exit: `/api/${API_PREFIX}/preview/exit`, words: devWords() }
        })
      }

      return plugin
    },
  }
}
