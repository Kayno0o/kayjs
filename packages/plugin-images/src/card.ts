// Build-time OG shareCard() generator for @kayjs/images:
// Renders a crisp 1200x630 SVG social card and rasterizes to PNG via `magick` when available
// (cached by content hash in `.kay-cache/images/`), with zero npm binary dependencies.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getAppContext } from 'kay/server'
import { escAttr } from 'kay/ssr'

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

export const SHARE_CARD_CONFIG_SERVICE = 'kay.images.shareCardConfig'

let magickFound: boolean | undefined

export function hasMagick(): boolean {
  return magickFound ??= Bun.which('magick') !== null
}

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
  const scoped = appCtx?.inject<ShareCardDefaults>(SHARE_CARD_CONFIG_SERVICE)
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
    .map((line, i) => `<text x="80" y="${titleStartY + i * 76}" fill="${fg}" font-family="${escAttr(font)}" font-size="62" font-weight="700">${escAttr(line)}</text>`)
    .join('')

  const subStartY = titleStartY + titleLines.length * 76 + 26
  const subSvg = subLines
    .map((line, i) => `<text x="80" y="${subStartY + i * 38}" fill="${muted}" font-family="${escAttr(font)}" font-size="28" font-weight="400">${escAttr(line)}</text>`)
    .join('')

  const badgeSvg = input.badge
    ? `<text x="80" y="135" fill="${accent}" font-family="${escAttr(font)}" font-size="24" font-weight="600" letter-spacing="3">${escAttr(input.badge.toUpperCase())}</text>`
    : ''

  let graphicSvg = ''
  if (input.image) {
    const rawImg = input.image.trim().startsWith('<svg')
      ? input.image
      : (existsSync(input.image) ? readFileSync(input.image, 'utf8') : '')
    if (rawImg.includes('<svg')) {
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(rawImg, 'utf8').toString('base64')}`
      graphicSvg = `<image href="${dataUri}" x="${width - 340}" y="175" width="260" height="260" />`
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${bg}"/>`
    + `<rect x="0" y="0" width="${width}" height="8" fill="${accent}"/>`
    + `<rect x="44" y="44" width="${width - 88}" height="${height - 88}" fill="none" stroke="${muted}" stroke-opacity="0.2" stroke-width="1.5"/>`
    + badgeSvg
    + titleSvg
    + subSvg
    + graphicSvg
    + `</svg>`
}

/** Generate a build-time OG social share card (PNG via ImageMagick when available, SVG fallback) and return its public URL. */
export function shareCard(input: ShareCardInput, overrides?: ShareCardDefaults): string {
  const cfg = { ...getCardConfig(), ...overrides }
  const svg = buildCardSvg(input, cfg)
  const hash = Bun.hash(svg).toString(36)
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'card'
  const appCtx = getAppContext()
  const publicDir = resolve(cfg.publicDir ?? appCtx?.publicDir ?? 'dist/public')
  const ogDir = join(publicDir, 'og')
  mkdirSync(ogDir, { recursive: true })

  const site = cfg.site ? cfg.site.replace(/\/$/, '') : ''

  if (hasMagick()) {
    const fileName = `${slug}-${hash}.png`
    const outPath = join(ogDir, fileName)
    if (existsSync(outPath)) {
      appCtx?.registerPublicFile(`og/${fileName}`)
      return `${site}/og/${fileName}`
    }

    const cacheDir = resolve(cfg.cacheDir ?? '.kay-cache/images')
    mkdirSync(cacheDir, { recursive: true })
    const cachedPng = join(cacheDir, `og-${fileName}`)

    if (existsSync(cachedPng)) {
      writeFileSync(outPath, readFileSync(cachedPng))
      appCtx?.registerPublicFile(`og/${fileName}`)
      return `${site}/og/${fileName}`
    }

    const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const tmpSvg = join(cacheDir, `og-${slug}-${hash}-${nonce}.svg`)
    const tmpPng = join(cacheDir, `og-${slug}-${hash}-${nonce}.png`)
    writeFileSync(tmpSvg, svg)
    const proc = Bun.spawnSync(['magick', tmpSvg, tmpPng], { stdout: 'pipe', stderr: 'pipe' })
    rmSync(tmpSvg, { force: true })
    if (proc.exitCode === 0 && existsSync(tmpPng)) {
      try {
        renameSync(tmpPng, cachedPng)
      }
      catch {
        rmSync(tmpPng, { force: true })
      }
      if (existsSync(cachedPng)) {
        writeFileSync(outPath, readFileSync(cachedPng))
        appCtx?.registerPublicFile(`og/${fileName}`)
        return `${site}/og/${fileName}`
      }
    }
    else {
      rmSync(tmpPng, { force: true })
    }
  }

  const svgFile = `${slug}-${hash}.svg`
  const svgOut = join(ogDir, svgFile)
  if (!existsSync(svgOut))
    writeFileSync(svgOut, svg)
  appCtx?.registerPublicFile(`og/${svgFile}`)
  return `${site}/og/${svgFile}`
}
