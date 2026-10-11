import type { Collection } from '../content'
import type { Project } from '../project'
import type { Cards } from './card'
import type { ClientBuild } from './client'
import type { I18n } from './i18n'
import type { Matcher } from './params'
import type { RenderOptions } from './render'
import type { Route, RouteMount } from './routes'
import type { ProjectSource } from './source'
import { join } from 'node:path'
import { setContentMode } from '../content/load'
import { projectCollections } from '../content/server'
import { renderOptionsOf } from '../project'
import { setSite } from '../runtime/site'
import { basePath } from './base'
import { setupCards } from './card'
import { readInlineStyles } from './client'
import { implicitI18n, loadI18n, routedSettings, serveLocales } from './i18n'
import { applyImageConfig } from './image'
import { loadMatchers } from './params'
import { setupPreview } from './preview'
import { refuseClashes, routeMounts } from './routes'
import { configHead, siteOrigin } from './seo'
import { projectSource } from './source'
import { setupStorage } from './storage'
import { setTracer } from './trace'

export interface PageSetup {
  source: ProjectSource
  client: ClientBuild
  mounts: RouteMount[]
  routes: Route[]
  matchers: Map<string, Matcher>
  collections: Collection<unknown>[]
  // The locales the config declares, or the site's one language.
  i18n: I18n | undefined
  locales: I18n
  base: string
  site: string | undefined
  scripts: string[]
  styles: string[]
  renderOptions: RenderOptions
  cards: Cards
}

// What serving pages and prerendering them both start from: the routes and their param matchers, the collections, the locales, the head and the render options.
// It installs what every render reads outside its request too: the `.kay` loader, the site, the image config, the share cards, the content's place and mode, the locales and the preview secret, with the tracer and the file store when serving, as a build traces nothing and an export links its files itself.
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

  serveLocales(root, locales)
  const base = basePath(config.base)
  const maxDensity = applyImageConfig(config.images)
  const site = config.site === undefined ? undefined : siteOrigin(config.site) + base

  setSite(site, config.trailingSlash, prerendering)
  setupPreview(config.preview, base)
  setContentMode(mode)

  if (!prerendering) {
    setTracer(config.tracer)
    setupStorage(config.storage, join(source.imageCache(root), 'stored'))
  }

  if (config.inlineStyles === true && !mode.dev)
    client.inlineStyles = await readInlineStyles(client, base)

  const [{ head, scripts, styles }, cards, collections] = await Promise.all([
    configHead(root, config, client.dir, source.embedded),
    setupCards({ dir: join(client.dir, '..'), clientDir: client.dir, fonts: (config.fonts?.length ?? 0) > 0, config: config.images?.card, name: config.seo?.name, quality: config.images?.quality, bundled: source.embedded, collect: prerendering }),
    projectCollections(root, config.content),
  ])

  return { source, client, mounts, routes, matchers, collections, i18n, locales, base, site, scripts, styles, renderOptions: renderOptionsOf(config, mode, { head, maxDensity }), cards }
}
