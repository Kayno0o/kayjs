// OG shareCard() generator for @kayjs/images:
// Renders a crisp 1200x630 SVG social card and rasterizes asynchronously to PNG via `rsvg-convert` or `magick`
// (cached by content hash in `.kay-cache/images/` at build time, or served from memory at runtime for --compile).

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isInside, serviceKey } from '@kayjs/kay/config'
import { getAppContext } from '@kayjs/kay/internal/server'
import { escAttr } from '@kayjs/kay/server'
import {
  computeEtag,
  hasMagick,
  hasRsvgConvert,
  isBuildPhase,
  queueBuildTask,
  rasterizeSvgToPngBytesAsync,
  RUNTIME_IMAGE_STORE_SERVICE,
} from './runtime'

export { hasMagick, hasRsvgConvert }

export interface ShareCardDefaults {
  /** Base URL prepended to returned card URL (optional, e.g. 'https://log.kaynooo.fr'). */
  site?: string | undefined
  /** Output public directory where `og/*.png` is written (default: `dist/public`). */
  publicDir?: string | undefined
  /** Disk cache directory (default: `.kay-cache/images`). */
  cacheDir?: string | undefined
  background?: string | undefined
  color?: string | undefined
  accent?: string | undefined
  mutedColor?: string | undefined
  fontFamily?: string | undefined
  width?: number | undefined
  height?: number | undefined
}

export interface ShareCardInput {
  title: string
  subtitle?: string | undefined
  badge?: string | undefined
  /** Optional inline SVG markup or path to an SVG file embedded on the right side of the card. */
  image?: string | undefined
  background?: string | undefined
  color?: string | undefined
  accent?: string | undefined
}

export const SHARE_CARD_CONFIG_SERVICE = serviceKey<ShareCardDefaults>('kay.images.shareCardConfig')

let standaloneCardConfig: ShareCardDefaults | undefined

export function configureShareCard(defaults: ShareCardDefaults): void {
  const appCtx = getAppContext()
  if (appCtx !== undefined)
    appCtx.provide(SHARE_CARD_CONFIG_SERVICE, defaults)
  else
    standaloneCardConfig = defaults
}

function getCardConfig(): ShareCardDefaults {
  const appCtx = getAppContext()
  const scoped = appCtx?.inject(SHARE_CARD_CONFIG_SERVICE)
  if (scoped !== undefined)
    return scoped
  if (appCtx !== undefined)
    return { publicDir: appCtx.publicDir }
  return standaloneCardConfig ?? {}
}


function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > maxChars && cur) {
      lines.push(cur)
      cur = w
      if (lines.length >= maxLines - 1)
        break
    }
    else {
      cur = next
    }
  }
  if (cur && lines.length < maxLines)
    lines.push(cur)
  return lines
}

function readConfinedSvgImage(imageSpec: string): string {
  if (imageSpec.trim().startsWith('<svg'))
    return imageSpec
  const rootDir = resolve(getAppContext()?.root ?? process.cwd())
  const absImg = resolve(rootDir, imageSpec)
  if (!isInside(rootDir, absImg) || !existsSync(absImg))
    return ''
  try {
    const realRoot = realpathSync(rootDir)
    const realImg = realpathSync(absImg)
    if (!isInside(realRoot, realImg))
      return ''
    return readFileSync(realImg, 'utf8')
  }
  catch {
    return ''
  }
}

function buildCardSvg(input: ShareCardInput, cfg: ShareCardDefaults): string {
  const width = cfg.width ?? 1200
  const height = cfg.height ?? 630
  const bg = input.background ?? cfg.background ?? '#090c13'
  const fg = input.color ?? cfg.color ?? '#dbe0ea'
  const accent = input.accent ?? cfg.accent ?? '#f5b83d'
  const muted = cfg.mutedColor ?? '#8b95aa'
  const font = cfg.fontFamily ?? 'system-ui, -apple-system, sans-serif'

  const hasGraphic = Boolean(input.image)
  const titleLines = wrapLines(input.title, hasGraphic ? 20 : 26, 3)
  const subLines = input.subtitle ? wrapLines(input.subtitle, hasGraphic ? 42 : 56, 2) : []

  const titleStartY = input.badge ? 235 : 210
  const titleSvg = titleLines
    .map((line, i) => `<text x="80" y="${titleStartY + i * 76}" fill="${escAttr(fg)}" font-family="${escAttr(font)}" font-size="62" font-weight="700">${escAttr(line)}</text>`)
    .join('')

  const subStartY = titleStartY + titleLines.length * 76 + 26
  const subSvg = subLines
    .map((line, i) => `<text x="80" y="${subStartY + i * 38}" fill="${escAttr(muted)}" font-family="${escAttr(font)}" font-size="28" font-weight="400">${escAttr(line)}</text>`)
    .join('')

  const badgeSvg = input.badge
    ? `<text x="80" y="135" fill="${escAttr(accent)}" font-family="${escAttr(font)}" font-size="24" font-weight="600" letter-spacing="3">${escAttr(input.badge.toUpperCase())}</text>`
    : ''

  let graphicSvg = ''
  if (input.image) {
    const rawImg = readConfinedSvgImage(input.image)
    if (rawImg.includes('<svg')) {
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(rawImg, 'utf8').toString('base64')}`
      graphicSvg = `<image href="${dataUri}" x="${width - 340}" y="175" width="260" height="260" />`
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${escAttr(bg)}"/>`
    + `<rect x="0" y="0" width="${width}" height="8" fill="${escAttr(accent)}"/>`
    + `<rect x="44" y="44" width="${width - 88}" height="${height - 88}" fill="none" stroke="${escAttr(muted)}" stroke-opacity="0.2" stroke-width="1.5"/>`
    + badgeSvg
    + titleSvg
    + subSvg
    + graphicSvg
    + `</svg>`
}

function writePngAtomic(dstPath: string, bytes: Uint8Array): void {
  const tmpPath = `${dstPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmpPath, bytes)
  try {
    renameSync(tmpPath, dstPath)
  }
  catch {
    rmSync(tmpPath, { force: true })
  }
}

/** Generate an OG social share card (async PNG via rsvg-convert/magick when available, SVG fallback) and return its public URL. */
export function shareCard(input: ShareCardInput, overrides?: ShareCardDefaults): string {
  const cfg = { ...getCardConfig(), ...overrides }
  const svg = buildCardSvg(input, cfg)
  const hash = Bun.hash(svg).toString(36)
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'card'
  const appCtx = getAppContext()
  const rawSite = cfg.site ?? appCtx?.site
  const site = rawSite ? rawSite.replace(/\/$/, '') : ''
  const canRasterize = hasRsvgConvert() || hasMagick()
  const inBuild = appCtx !== undefined && isBuildPhase(appCtx.outDir)

  // Runtime server mode (including --compile): serve from bounded in-memory store with async Bun.spawn, zero dist/public writes.
  const runtimeStore = overrides?.publicDir === undefined ? appCtx?.inject(RUNTIME_IMAGE_STORE_SERVICE) : undefined
  if (runtimeStore !== undefined && !inBuild) {
    if (canRasterize) {
      const fileName = `${slug}-${hash}.png`
      const urlPath = `/og/${fileName}`
      const cacheDir = cfg.cacheDir !== undefined ? resolve(cfg.cacheDir) : undefined
      const cachedPng = cacheDir !== undefined ? join(cacheDir, `og-${fileName}`) : undefined
      runtimeStore.setLazy(urlPath, async () => {
        if (cachedPng !== undefined && existsSync(cachedPng)) {
          const cached = await Bun.file(cachedPng).arrayBuffer().then(buf => new Uint8Array(buf), () => undefined)
          if (cached !== undefined)
            return { body: cached, contentType: 'image/png', etag: computeEtag(cached) }
        }
        const png = await rasterizeSvgToPngBytesAsync(svg)
        if (png !== undefined)
          return { body: png, contentType: 'image/png', etag: computeEtag(png) }
        return { body: svg, contentType: 'image/svg+xml', etag: computeEtag(svg) }
      })
      return `${site}${urlPath}`
    }
    const svgFile = `${slug}-${hash}.svg`
    const urlPath = `/og/${svgFile}`
    runtimeStore.setStatic(urlPath, svg, 'image/svg+xml')
    return `${site}${urlPath}`
  }

  // Build / prerender or standalone explicit publicDir mode
  const publicDir = resolve(cfg.publicDir ?? appCtx?.publicDir ?? 'dist/public')
  const ogDir = join(publicDir, 'og')
  mkdirSync(ogDir, { recursive: true })

  if (canRasterize) {
    const fileName = `${slug}-${hash}.png`
    const outPath = join(ogDir, fileName)
    if (existsSync(outPath)) {
      appCtx?.registerPublicFile(`og/${fileName}`)
      return `${site}/og/${fileName}`
    }

    const cacheDir = resolve(cfg.cacheDir ?? '.kay-cache/images')
    const cachedPng = join(cacheDir, `og-${fileName}`)
    if (existsSync(cachedPng)) {
      writeFileSync(outPath, readFileSync(cachedPng))
      appCtx?.registerPublicFile(`og/${fileName}`)
      return `${site}/og/${fileName}`
    }

    if (inBuild) {
      appCtx.registerPublicFile(`og/${fileName}`)
      queueBuildTask(appCtx.outDir, (async () => {
        const png = await rasterizeSvgToPngBytesAsync(svg)
        if (png === undefined)
          return
        mkdirSync(cacheDir, { recursive: true })
        writePngAtomic(cachedPng, png)
        mkdirSync(ogDir, { recursive: true })
        writeFileSync(outPath, png)
      })())
      return `${site}/og/${fileName}`
    }
  }

  const svgFile = `${slug}-${hash}.svg`
  const svgOut = join(ogDir, svgFile)
  if (!existsSync(svgOut))
    writeFileSync(svgOut, svg)
  appCtx?.registerPublicFile(`og/${svgFile}`)
  return `${site}/og/${svgFile}`
}
