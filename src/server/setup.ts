import type { Collection } from '../content'
import type { Project } from '../project'
import type { LocaleSettings } from '../runtime/i18n'
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
import { extensionServers } from '../config'
import { setContentMode, setMarkdownDefaults } from '../content/load'
import { projectCollections } from '../content/server'
import { renderOptionsOf } from '../project'
import { setSite } from '../runtime/site'
import { setupStore } from './app-store'
import { basePath } from './base'
import { checkCardConfig, drawLogo, setupCards } from './card'
import { chooseInlineStyles } from './client'
import { appServesManifest } from './favicon'
import { implicitI18n, linkedSettings, loadI18n, routedSettings, serveLocales } from './i18n'
import { applyImageConfig } from './image'
import { loadMatchers } from './params'
import { setupPreview } from './preview'
import { dropOpenCache, privateDir } from './private-dir'
import { publicFiles } from './public'
import { refuseClashes } from './route-table'
import { refuseRouteNames, routeMounts, styleChains } from './routes'
import { islandOnlyChunks } from './save-data'
import { allowsStyleAttributes } from './security'
import { configHead, siteWithBase } from './seo'
import { projectSource } from './source'
import { setupStampSecret, warnOnStampKey } from './stamp'
import { setupStorage } from './storage'
import { setTracer } from './trace'

// What the config's refusals that need the scanned project read, handed to the check a server passes before any client build starts.
export interface Scanned {
  routes: Route[]
  files: PublicFile[]
  endpoints: Endpoint[]
  collections: Collection<unknown>[]
  i18n: LocaleSettings | undefined
  site: string | undefined
  base: string
}

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
  // The extension servers and API modules, imported while the client builds; nothing prerendering reads.
  extensions: Promise<Awaited<ReturnType<typeof extensionServers>>>
  api: ReturnType<ProjectSource['api']>
}

// What serving pages and prerendering them both start from: the routes and their param matchers, the collections, the locales, the head and the render options.
// It installs what every render reads outside its request too: the `.kay` loader, the site, the image config, the share cards, the content's place and mode and the locales, with the preview secret, the tracer and the file store when serving, as a build traces nothing, previews nothing and an export links its files itself.
// `refuse` is the check a server passes to refuse the config before the build starts, and what it claimed comes back as `claimed` for the server to go on from.
export async function setupPages<Claimed = undefined>(project: Project, loadClient: () => ClientBuild | Promise<ClientBuild>, prerendering = false, redirectSpelling?: RenderOptions['redirectSpelling'], refuse?: (scanned: Scanned) => Claimed): Promise<PageSetup & { claimed: Claimed }> {
  let loading: Promise<ClientBuild> | undefined

  try {
    return await setupWith(project, async () => loading ??= Promise.resolve(loadClient()), prerendering, redirectSpelling, refuse)
  }
  catch (error) {
    // A build still running would go on writing the output while the caller deals with the failure.
    await Promise.allSettled([loading])

    throw error
  }
}

async function setupWith<Claimed>(project: Project, loadClient: () => Promise<ClientBuild>, prerendering: boolean, redirectSpelling: RenderOptions['redirectSpelling'], refuse: ((scanned: Scanned) => Claimed) | undefined): Promise<PageSetup & { claimed: Claimed }> {
  const { root, config, paths, mode } = project
  const mounts = routeMounts(root, config.extensions)
  const source = projectSource()
  // Drawn while the project is scanned, unless a build or an executable holds the drawing; a logo kay cannot draw refuses the config before the build starts.
  const logoFile = config.images?.card?.logo === undefined ? undefined : resolve(root, config.images.card.logo)
  const logoDrawn = logoFile !== undefined && !source.embedded && !mode.prebuilt ? drawLogo(logoFile) : undefined

  void Promise.allSettled([logoDrawn])

  await source.prepare(root, config.settings)
  // Scanned beside the routes, which the refusals before the build need.
  const scanning = Promise.all([publicFiles(paths.public), source.endpoints(paths.routes, mounts)])

  void Promise.allSettled([scanning])

  const routes = await source.routes(paths.routes, mounts)

  // A server's check claims the routes itself, once the locales are known.
  if (refuse)
    refuseRouteNames(paths.routes, routes)
  else
    refuseClashes(paths.routes, routes)

  const [matchers, i18n] = await Promise.all([loadMatchers(paths.routes, routes), config.i18n && loadI18n(root, config.i18n, config.extensions)])

  if (i18n)
    i18n.settings = routedSettings(i18n.settings, routes)

  // Without `i18n`, every request runs in the site's one language, its extensions' messages and the app's read.
  const locales = i18n ?? await implicitI18n(root, config.lang, config.extensions)

  serveLocales(root, locales)
  const base = basePath(config.base)
  const maxDensity = applyImageConfig(config.images, config.security === false || allowsStyleAttributes(config.security?.csp, config.security?.reportOnly))
  const site = siteWithBase(config.site, config.base)

  // Holds copies of private files and their variants, so only this user may enter it.
  const imageCache = await privateDir(source.imageCache(root))

  if (source.embedded)
    await dropOpenCache()

  setSite(site, config.trailingSlash, prerendering, config.links?.outside === 'same-tab')
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

  setMarkdownDefaults(config.markdown)

  // The content config is imported beside the scans, as its refusals (a missing file, a feed without the site) come before the build too.
  const loadingCollections = projectCollections(root, config.content)

  void Promise.allSettled([loadingCollections])

  const [files, endpoints] = await scanning
  const ownManifest = appServesManifest(files, endpoints, routes)

  checkCardConfig(config.images?.card, config.fonts)
  await logoDrawn

  const collections = await loadingCollections

  const claimed = refuse?.({ routes, files, endpoints, collections, i18n: i18n?.settings, site, base }) as Claimed

  // Started once every refusal that needs no build is behind, those of the config (images, markdown, i18n, matchers, base, preview, the cards) and of the scanned project, the server's own among them; only what needs the built client or the routes' guards (the font faces of a Fontsource family, API modules, extension routes) still follows it.
  // Awaited where the first thing reading it needs it, so what does not depend on it is done while it builds.
  const loadingClient = loadClient()

  void Promise.allSettled([loadingClient])

  // Imported while the client builds; the content config is already imported, so an extension or API module may read the collections at import time.
  const extensions = prerendering ? Promise.resolve([]) : extensionServers(config.extensions, root)
  const api = prerendering ? Promise.resolve([]) : source.api(root, config)

  void Promise.allSettled([extensions, api])

  const client = await loadingClient

  if (!mode.dev)
    await chooseInlineStyles(client, base, config.inlineStyles, styleChains(routes), config.offline === undefined || config.offline === false, config.lateStyles === true)

  // Cards are drawn in the fonts the head just wrote, rather than those a `fonts.json` held before.
  const headAndCards = async () => {
    const { fonts, ...head } = await configHead(root, config, client.dir, source.embedded, ownManifest)

    return { ...head, fontCss: fonts?.css, cards: await setupCards({ dir: join(client.dir, '..'), clientDir: client.dir, fonts, config: config.images?.card, logo: logoFile, logoDrawn, name: config.seo?.name, defaultLocale: locales.settings.defaultLocale, quality: config.images?.quality, bundled: source.embedded, prebuilt: mode.prebuilt, collect: prerendering }) }
  }

  const { head, scripts, styles, cards, fontCss } = await headAndCards()

  // A localized site's links are told of its pages and localized feeds, for the server and the static export alike.
  if (i18n)
    i18n.settings = linkedSettings(i18n.settings, routes, collections)

  return { source, client, mounts, routes, matchers, collections, i18n, locales, base, site, imageCache, scripts, styles, renderOptions: { ...renderOptionsOf(config, mode, { head, maxDensity, fontCss, islandPreloads: mode.dev ? undefined : islandOnlyChunks(client), editor: source.editor(root, config) }), redirectSpelling }, cards, files, endpoints, appManifest: ownManifest, extensions, api, claimed }
}
