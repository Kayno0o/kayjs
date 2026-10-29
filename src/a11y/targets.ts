import type { KayConfig } from '../config'
import { relative } from 'node:path'
import { projectPaths } from '../project'
import { localeCopies, localeSettings, routedSettings } from '../server/i18n'
import { registerLoader } from '../server/loader'
import { pageSetting } from '../server/page-settings'
import { listedIn, listedParams, pathOf } from '../server/prerendered'
import { routeMounts, scanRoutes, slashedPath } from '../server/routes'

// A page of the site to audit, at the path a visitor types.
export interface Target {
  path: string
  // The route's pattern and file, from the project's root, which every finding on the page names.
  route: string
  file: string
  locale: string | undefined
}

// A page the audit did not open, and why. `failed` is for what the site gets wrong, such as a route that cannot load; a page behind a sign-in or with no params to fill is only left out.
export interface Skipped {
  path: string
  route: string
  file: string
  why: string
  // The same reason in French, for the RGAA draft.
  whyFr: string
  failed: boolean
}

// Every page the build knows, as `kay routes` lists them: a page without params once per locale, one with params for the values its `prerender` (else `sitemap`) export lists.
export async function pagesToAudit(root: string, config: KayConfig): Promise<{ targets: Target[], skipped: Skipped[] }> {
  const { routes: routesDir } = projectPaths(root, config)
  const pages = await scanRoutes(routesDir, routeMounts(root, config.extensions))
  const settings = config.i18n && routedSettings(localeSettings(config.i18n), pages)
  const targets: Target[] = []
  const skipped: Skipped[] = []

  await registerLoader(root, config.librarySettings ?? {})

  for (const route of pages) {
    const file = relative(root, route.file)
    const left = (why: string, whyFr: string, failed: boolean, path = route.pattern) => skipped.push({ path, route: route.pattern, file, why, whyFr, failed })

    try {
      const module = await import(route.file) as object
      const name = (['sitemap', 'prerender'] as const).find(each => pageSetting(module, each) !== undefined)

      if (route.params.length > 0 && name === undefined) {
        left(`it takes ${route.params.join(', ')} and lists no values: add \`prerender\` or \`sitemap\` to its \`page\` export`, `elle prend ${route.params.join(', ')} sans en lister les valeurs : ajouter \`prerender\` ou \`sitemap\` à son export \`page\``, false)

        continue
      }

      const listed = route.params.length === 0 ? [{}] : await listedParams(route, file, name!, pageSetting(module, name!), settings)

      for (const params of listed) {
        for (const copy of localeCopies(settings, pathOf(route, params)).filter(copy => listedIn(params, copy.locale, settings))) {
          const path = slashedPath(copy.path, config.trailingSlash)

          if (copy.host === undefined)
            targets.push({ path, route: route.pattern, file, locale: copy.locale })
          else
            left(`its ${copy.locale} copy is served on ${copy.host}, which a browser here cannot reach by name`, `sa copie ${copy.locale} est servie sur ${copy.host}, qu'un navigateur d'ici ne peut pas joindre par son nom`, false, path)
        }
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      left(`it cannot be listed: ${message}`, `elle ne peut pas être listée : ${message}`, true)
    }
  }

  return { targets, skipped }
}
