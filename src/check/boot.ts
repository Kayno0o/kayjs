import type { CheckDiagnostic, CheckOptions } from '.'
import type { LocaleSettings } from '../runtime/i18n'
import { join, resolve } from 'node:path'
import { islandId } from '../compiler'
import { NOT_ACTIONS } from '../compiler/codegen'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { CONFIG_FILE } from '../config'
import { actionUrl } from '../runtime/action'
import { actionClash } from '../server/actions'
import { basePath } from '../server/base'
import { localeSettings, refuseLocaleClashes } from '../server/i18n'
import { refuseShutdownTimeout } from '../server/lifecycle'
import { publicFiles, refusePublicClashes } from '../server/public'
import { readRedirects, refuseRedirectClashes } from '../server/redirects'
import { refuseClashes, scanRoutes } from '../server/routes'
import { siteOrigin } from '../server/seo'

// What the server refuses when it boots, found by the functions it calls then, so `kay check` and the boot cannot disagree.
// Only `kay check` and `kay build` look for them: the editor reads routes mid-edit, two pages serving one path among them.
export async function bootProblems(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const diagnostics: CheckDiagnostic[] = []
  const config = join(root, CONFIG_FILE)
  const routesDir = resolve(root, options.routes ?? 'src/routes')
  const publicDir = resolve(root, options.publicDir ?? 'public')
  const [routes, files] = await Promise.all([scanRoutes(routesDir), publicFiles(publicDir)])

  const refused = (file: string, run: () => void) => {
    try {
      run()
    }
    catch (error) {
      diagnostics.push({ file, line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const { base, site, shutdownTimeout } = options

  refused(config, () => basePath(base))

  if (site !== undefined)
    refused(config, () => siteOrigin(site))

  if (shutdownTimeout !== undefined)
    refused(config, () => refuseShutdownTimeout(shutdownTimeout))

  refused(config, () => refuseRedirectClashes(readRedirects(options.redirects ?? {}), routes))
  refused(routesDir, () => refuseClashes(routesDir, routes))
  refused(publicDir, () => refusePublicClashes(files, routes))

  let settings: LocaleSettings | undefined

  // Settings the server would refuse are reported with the shadow types already.
  try {
    settings = options.i18n && localeSettings(options.i18n)
  }
  catch {}

  if (settings)
    refused(config, () => refuseLocaleClashes(settings, routes))

  diagnostics.push(...await actionClashes(root, [...new Set(routes.flatMap(route => [...route.layouts, route.file]))]))

  return diagnostics
}

// The URL each action of the pages and layouts is served at, as the server registers it, reported where a second file takes one.
async function actionClashes(root: string, files: string[]): Promise<CheckDiagnostic[]> {
  const diagnostics: CheckDiagnostic[] = []
  const served = new Map<string, string>()

  for (const file of files) {
    const source = await Bun.file(file).text()
    const names = analyzeServer(source, parseKay(source).server)?.exportNames.filter(name => !NOT_ACTIONS.has(name)) ?? []

    for (const name of names) {
      const url = actionUrl(islandId(file, root), name)
      const taken = served.get(url)

      if (taken === undefined)
        served.set(url, file)
      else if (taken !== file)
        diagnostics.push({ file, line: 1, column: 1, message: actionClash(taken, file, url).message })
    }
  }

  return diagnostics
}
