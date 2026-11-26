// A folder of `.svg` files read as an icon set, each file an icon named after it, the way Iconify's importDirectory does.

import type { IconifyIcon, IconSet } from './types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SVG_RE = /<svg\b([^>]*)>([\s\S]*)<\/svg\s*>/i
const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const COMMENT_RE = /<!--[\s\S]*?-->/g
const NUMBER_RE = /^\s*(-?[\d.]+)(?:px)?\s*$/
const BOX_SEPARATOR_RE = /[\s,]+/
// Root attributes that paint the glyph, kept on a group around it when the file drops its <svg> element.
const PAINT_ATTR_RE = /^(?:fill|stroke|color|opacity|clip-rule|fill-.+|stroke-.+)$/

export interface SvgDirSet {
  set: IconSet
  /** Why a file is not an icon, keyed by the icon name it would have. */
  problems: Map<string, string>
}

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, name, double, single] of source.matchAll(ATTR_RE))
    found.set(name!, double ?? single ?? '')
  return found
}

function number(value: string | undefined): number | undefined {
  const match = value === undefined ? null : NUMBER_RE.exec(value)
  return match === null ? undefined : Number(match[1])
}

/** The icon drawn by an SVG file's source, or why it cannot be one. */
export function svgIcon(source: string): IconifyIcon | string {
  const svg = SVG_RE.exec(source.replace(COMMENT_RE, ''))
  if (svg === null)
    return 'holds no <svg> element'
  const attrs = attributes(svg[1]!)
  const box = attrs.get('viewBox')?.trim().split(BOX_SEPARATOR_RE).map(Number)
  const [left, top, width, height] = box?.length === 4 && box.every(Number.isFinite) ? box : [0, 0, number(attrs.get('width')), number(attrs.get('height'))]
  if (width === undefined || height === undefined || width <= 0 || height <= 0)
    return 'has no viewBox, nor a width and height, to size it: add viewBox="0 0 <width> <height>" to its <svg>'

  const paint = [...attrs].filter(([name]) => PAINT_ATTR_RE.test(name)).map(([name, value]) => ` ${name}="${value}"`).join('')
  const body = svg[2]!.trim()
  return { body: paint === '' ? body : `<g${paint}>${body}</g>`, left: left!, top: top!, width, height }
}

/** The icons of the `.svg` files directly in `dir`, undefined when the folder does not exist. */
export async function readSvgDir(prefix: string, dir: string): Promise<SvgDirSet | undefined> {
  if (!existsSync(dir))
    return undefined
  const set: IconSet = { prefix, icons: {} }
  const problems = new Map<string, string>()
  for (const file of new Bun.Glob('*.svg').scanSync({ cwd: dir })) {
    const name = file.slice(0, -'.svg'.length)
    const icon = svgIcon(await Bun.file(join(dir, file)).text())
    if (typeof icon === 'string')
      problems.set(name, icon)
    else
      set.icons[name] = icon
  }
  return { set, problems }
}
