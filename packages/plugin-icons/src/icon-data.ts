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

// The viewBox, size and body Iconify's `iconToSVG` would draw: flips first, then the rotation around them, a quarter turn swapping the sides.
export function iconData(set: IconSet, name: string): IconData | undefined {
  const ownPrefix = `${set.prefix}:`
  const icon = resolveIcon(set, name.startsWith(ownPrefix) ? name.slice(ownPrefix.length) : name, 0)
  if (icon?.body === undefined || icon.body === '')
    return undefined

  const box = {
    left: icon.left ?? set.left ?? 0,
    top: icon.top ?? set.top ?? 0,
    width: icon.width ?? set.width ?? DEFAULT_SIZE,
    height: icon.height ?? set.height ?? DEFAULT_SIZE,
  }
  if (!(box.width > 0 && box.height > 0))
    return undefined

  const hFlip = icon.hFlip ?? set.hFlip ?? false
  const vFlip = icon.vFlip ?? set.vFlip ?? false
  let rotate = icon.rotate ?? set.rotate ?? 0
  const transforms: string[] = []

  if (hFlip && vFlip) {
    rotate += 2
  }
  else if (hFlip || vFlip) {
    transforms.push(hFlip ? `translate(${box.width + box.left} ${-box.top})` : `translate(${-box.left} ${box.height + box.top})`, hFlip ? 'scale(-1 1)' : 'scale(1 -1)')
    box.left = 0
    box.top = 0
  }

  rotate = ((rotate % 4) + 4) % 4
  if (rotate === 1)
    transforms.unshift(`rotate(90 ${box.height / 2 + box.top} ${box.height / 2 + box.top})`)
  else if (rotate === 2)
    transforms.unshift(`rotate(180 ${box.width / 2 + box.left} ${box.height / 2 + box.top})`)
  else if (rotate === 3)
    transforms.unshift(`rotate(-90 ${box.width / 2 + box.left} ${box.width / 2 + box.left})`)
  if (rotate % 2 === 1)
    [box.left, box.top, box.width, box.height] = [box.top, box.left, box.height, box.width]

  return {
    viewBox: `${box.left} ${box.top} ${box.width} ${box.height}`,
    width: `${Math.round((box.width / box.height) * 1000) / 1000}em`,
    height: '1em',
    body: transforms.length > 0 ? `<g transform="${transforms.join(' ')}">${icon.body}</g>` : icon.body,
  }
}
