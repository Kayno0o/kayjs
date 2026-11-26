import type { IconData, IconifyIcon, IconSet } from './types'

const DEFAULT_SIZE = 16

function resolveIcon(set: IconSet, name: string, depth: number): IconifyIcon | undefined {
  const own = set.icons[name]
  if (own !== undefined)
    return own

  const alias = set.aliases?.[name]
  if (alias?.parent === undefined || alias.parent === '' || depth > 8)
    return undefined

  const parent = resolveIcon(set, alias.parent, depth + 1)
  if (parent === undefined)
    return undefined

  return {
    ...parent,
    ...alias,
    body: parent.body,
    hFlip: Boolean(parent.hFlip) !== Boolean(alias.hFlip),
    vFlip: Boolean(parent.vFlip) !== Boolean(alias.vFlip),
    rotate: (parent.rotate ?? 0) + (alias.rotate ?? 0),
  }
}

export function iconData(set: IconSet, name: string): IconData | undefined {
  const ownPrefix = `${set.prefix}:`
  const icon = resolveIcon(set, name.startsWith(ownPrefix) ? name.slice(ownPrefix.length) : name, 0)
  if (icon?.body === undefined || icon.body === '')
    return undefined

  const width = icon.width ?? set.width ?? DEFAULT_SIZE
  const height = icon.height ?? set.height ?? DEFAULT_SIZE
  const left = icon.left ?? 0
  const top = icon.top ?? 0
  const transforms: string[] = []

  if (icon.hFlip)
    transforms.push(`translate(${left * 2 + width} 0) scale(-1 1)`)
  if (icon.vFlip)
    transforms.push(`translate(0 ${top * 2 + height}) scale(1 -1)`)
  if (icon.rotate !== undefined && icon.rotate !== 0)
    transforms.push(`rotate(${(icon.rotate % 4) * 90} ${left + width / 2} ${top + height / 2})`)

  const body = transforms.length > 0 ? `<g transform="${transforms.join(' ')}">${icon.body}</g>` : icon.body

  return {
    viewBox: `${left} ${top} ${width} ${height}`,
    width: `${Math.round((width / height) * 1000) / 1000}em`,
    height: '1em',
    body,
  }
}
