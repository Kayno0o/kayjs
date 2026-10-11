import type { Project } from '../project'
import type { ClientBuild } from './client'
import type { I18n } from './i18n'
import type { Matcher } from './params'
import type { RenderOptions } from './render'
import type { Route, RouteMount } from './routes'
import type { ProjectSource } from './source'
import { renderOptionsOf } from '../project'
import { setSite } from '../runtime/site'
import { basePath } from './base'
import { readInlineStyles } from './client'
import { implicitI18n, loadI18n, routedSettings } from './i18n'
import { applyImageConfig } from './image'
import { loadMatchers } from './params'
import { refuseClashes, routeMounts } from './routes'
import { configHead, siteOrigin } from './seo'
import { projectSource } from './source'

export interface PageSetup {
  source: ProjectSource
  client: ClientBuild
  mounts: RouteMount[]
  routes: Route[]
  matchers: Map<string, Matcher>
  // The locales the config declares, or the site's one language.
  i18n: I18n | undefined
  locales: I18n
  base: string
  site: string | undefined
  scripts: string[]
  styles: string[]
  renderOptions: RenderOptions
}

// What serving pages and prerendering them both start from: the routes and their param matchers, the locales, the site and the images it sets for every render, the head and the render options.
export async function setupPages(project: Project, loadClient: () => Promise<ClientBuild>, prerendering = false): Promise<PageSetup> {
  const { root, config, paths, mode } = project
  const mounts = routeMounts(root, config.extensions)
  const source = projectSource()

  await source.prepare(root, config.settings)
  const [routes, client] = await Promise.all([source.routes(paths.routes, mounts), loadClient()])

  refuseClashes(paths.routes, routes)
  const [matchers, i18n] = await Promise.all([loadMatchers(paths.routes, routes), config.i18n && loadI18n(root, config.i18n, config.extensions)])

  if (i18n)
    i18n.settings = routedSettings(i18n.settings, routes)

  // Without `i18n`, every request runs in the site's one language, its extensions' messages and the app's read.
  const locales = i18n ?? await implicitI18n(root, config.lang, config.extensions)
  const base = basePath(config.base)
  const maxDensity = applyImageConfig(config.images)
  const site = config.site === undefined ? undefined : siteOrigin(config.site) + base

  setSite(site, config.trailingSlash, prerendering)

  if (config.inlineStyles === true && !mode.dev)
    client.inlineStyles = await readInlineStyles(client, base)

  const { head, scripts, styles } = await configHead(root, config, client.dir, source.embedded)

  return { source, client, mounts, routes, matchers, i18n, locales, base, site, scripts, styles, renderOptions: renderOptionsOf(config, mode, { head, maxDensity }) }
}
