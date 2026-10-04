import type { BunPlugin } from 'bun'
import type { JsonLd } from './runtime/seo'
import type { Prefetch } from './server/speculation'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// What `kay.config.ts` exports by default; `pages()`, `kay build`, `kay dev` and `kay check` all read it.
export interface KayConfig {
  // Page directory, relative to the root. Defaults to `src/routes`.
  routes?: string
  // Files served as they are at their path, relative to the root. Defaults to `public`.
  publicDir?: string
  minify?: boolean
  lang?: string
  // The origin the site is public at, `https://example.com`: canonical links, social URLs and the sitemap are built from it.
  site?: string
  seo?: SeoConfig
  images?: ImagesConfig
  // A square image, 512 pixels wide or more, relative to the root: kay serves it as `/favicon.ico`, `/apple-touch-icon.png` and the icons of `/manifest.webmanifest`, linked from every page.
  favicon?: string
  // The web manifest served with the favicon, named after `seo.name`.
  manifest?: ManifestConfig
  // Self-hosted fonts, declared and preloaded on every page.
  fonts?: FontConfig[]
  // When the browser fetches a page a link points at before it is followed: `moderate`, the default, on hover. A link with `data-no-prefetch` never is.
  prefetch?: Prefetch
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[]
  // Receives every error a load, a render, a guard or an action throws, as it is logged: the place to send them to an error tracker.
  onError?: (error: unknown, request: Request) => void | Promise<void>
}

// What every page's head starts from; a layout or the page setting the same tag wins.
export interface SeoConfig {
  // The site's name: the title of a page that sets none, and `og:site_name`.
  name?: string
  // Wraps the title a layout or the page sets: `%s | Site`.
  titleTemplate?: string
  description?: string
  // The social card image, a URL or a path such as an imported asset's.
  image?: string
  // The site's Twitter handle, `@site`.
  twitter?: string
  // `og:locale`, such as `fr_FR`.
  locale?: string
  // Structured data every page carries, such as the site's `WebSite` or `Organization`.
  jsonLd?: JsonLd[]
}

export interface FontConfig {
  family: string
  // A font file relative to the root, or a file of an installed package: `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`.
  src: string
  // A weight, or a range for a variable font: `100 900`. Defaults to 400.
  weight?: number | string
  style?: 'normal' | 'italic'
  // Defaults to `swap`.
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional'
  unicodeRange?: string
  // Fetched with the page rather than once the stylesheet asks for it; on by default, worth turning off for a face few pages use.
  preload?: boolean
}

export interface ManifestConfig {
  // The name under the icon on a home screen; defaults to `seo.name`.
  shortName?: string
  // Also every page's `theme-color`.
  themeColor?: string
  backgroundColor?: string
  display?: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser'
}

export interface ImagesConfig {
  // Directories of images added at runtime, such as uploads, by the URL path the app serves them at: `{ '/uploads/': 'data/uploads' }`. The image route resizes those as well as imported images, reading them on each request; a directory is relative to the root, or where an executable runs.
  dirs?: Record<string, string>
  // WebP quality, 1 to 100. Defaults to 80.
  quality?: number
}

export const CONFIG_FILE = 'kay.config.ts'

export function defineConfig(config: KayConfig): KayConfig {
  return config
}

export async function loadConfig(root: string): Promise<KayConfig> {
  const file = join(root, CONFIG_FILE)

  if (!existsSync(file))
    return {}

  const { default: config } = await import(file) as { default?: KayConfig }

  if (typeof config !== 'object' || config === null)
    throw new Error(`kay: ${CONFIG_FILE} must export its config by default: export default defineConfig({ ... })`)

  return config
}

// The project's config under the options given in code; an option passed as `undefined` leaves the config's value alone rather than wiping it.
export async function withConfig<Options extends KayConfig>(root: string, options: Options): Promise<KayConfig & Options> {
  return mergeConfig(await loadConfig(root), options)
}

export function mergeConfig<Options extends KayConfig>(config: KayConfig, options: Options): KayConfig & Options {
  return { ...config, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as KayConfig & Options
}
