import type { Collection } from '../content'
import type { Project } from '../project'
import type { Cards } from './card'
import type { ClientBuild } from './client'
import type { I18n } from './i18n'
import type { Matcher } from './params'
import type { PublicFile } from './public'
import type { RenderOptions } from './render'
import type { Endpoint, Route, RouteMount } from './routes'
import type { ProjectSource } from './source'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setContentMode, setMarkdownDefaults } from '../content/load'
import { projectCollections } from '../content/server'
import { renderOptionsOf } from '../project'
import { setSite } from '../runtime/site'
import { setupStore } from './app-store'
import { basePath } from './base'
import { setupCards } from './card'
import { chooseInlineStyles } from './client'
import { appServesManifest } from './favicon'
import { implicitI18n, linkedSettings, loadI18n, routedSettings, serveLocales } from './i18n'
import { applyImageConfig } from './image'
import { loadMatchers } from './params'
import { setupPreview } from './preview'
import { dropOpenCache, privateDir } from './private-dir'
import { publicFiles } from './public'
import { refuseClashes } from './route-table'
import { routeMounts, styleChains } from './routes'
import { configHead, siteOrigin } from './seo'
import { projectSource } from './source'
import { setupStampSecret, warnOnStampKey } from './stamp'
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
  // Where resized images, remote ones and stored files are kept.
  imageCache: string
  scripts: string[]
  styles: string[]
  renderOptions: RenderOptions
  cards: Cards
  // The files of `public/` and the endpoints, which the server claims paths for once it boots.
  files: PublicFile[]
  endpoints: Endpoint[]
  // Whether the app serves the default manifest itself, which kay then links in place of the locales'.
  appManifest: boolean
}

// What serving pages and prerendering them both start from: the routes and their param matchers, the collections, the locales, the head and the render options.
// It installs what every render reads outside its request too: the `.kay` loader, the site, the image config, the share cards, the content's place and mode and the locales, with the preview secret, the tracer and the file store when serving, as a build traces nothing, previews nothing and an export links its files itself.
export async function setupPages(project: Project, loadClient: () => ClientBuild | Promise<ClientBuild>, prerendering = false): Promise<PageSetup> {
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

  // Holds copies of private files and their variants, so only this user may enter it.
  const imageCache = await privateDir(source.imageCache(root))

  if (source.embedded)
    await dropOpenCache()

  setSite(site, config.trailingSlash, prerendering)
  setContentMode(mode, paths.output)

  // A build may run without the server's secrets, the preview one included.
  if (!prerendering) {
    setupStampSecret(config.secret)
    setupPreview(config.preview, base)
    setTracer(config.tracer)
    setupStorage(config.storage, join(imageCache, 'stored'), imageCache)
    setupStore(config.store)
    // A test's server restarts with its process and has no replica, so a key of the process is right there.
    warnOnStampKey(!mode.dev && process.env.NODE_ENV !== 'test')
  }

  if (!mode.dev)
    await chooseInlineStyles(client, base, config.inlineStyles, styleChains(routes), config.offline === undefined || config.offline === false, config.lateStyles === true)

  const [files, endpoints] = await Promise.all([publicFiles(paths.public), source.endpoints(paths.routes, mounts)])
  const ownManifest = appServesManifest(files, endpoints, routes)

  // Cards are drawn in the fonts the head just wrote, rather than those a `fonts.json` held before.
  const headAndCards = async () => {
    const { fonts, ...head } = await configHead(root, config, client.dir, source.embedded, ownManifest)

    return { ...head, cards: await setupCards({ dir: join(client.dir, '..'), clientDir: client.dir, fonts, config: config.images?.card, logo: config.images?.card?.logo === undefined ? undefined : resolve(root, config.images.card.logo), name: config.seo?.name, defaultLocale: locales.settings.defaultLocale, quality: config.images?.quality, bundled: source.embedded, prebuilt: mode.prebuilt, collect: prerendering }) }
  }

  setMarkdownDefaults(config.markdown)

  const [{ head, scripts, styles, cards }, collections] = await Promise.all([headAndCards(), projectCollections(root, config.content)])

  // A localized site's links are told of its pages and localized feeds, for the server and the static export alike.
  if (i18n)
    i18n.settings = linkedSettings(i18n.settings, routes, collections)

  return { source, client, mounts, routes, matchers, collections, i18n, locales, base, site, imageCache, scripts, styles, renderOptions: renderOptionsOf(config, mode, { head, maxDensity, editor: source.editor(root, config) }), cards, files, endpoints, appManifest: ownManifest }
}
