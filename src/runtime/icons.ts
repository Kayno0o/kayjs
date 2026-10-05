// What `import home from '~icons/tabler/home'` gives: the props an `svg` spreads to draw it, `svg({...home})`, sized to the text around it.
export interface IconProps {
  'viewBox': string
  'width': string
  'height': string
  'aria-hidden': 'true'
  'innerHTML': string
}

// An iconify set as `@iconify-json/<prefix>/icons.json` holds it.
export interface IconSet {
  prefix: string
  icons: Record<string, IconifyIcon>
  aliases?: Record<string, IconifyIcon>
  width?: number
  height?: number
}

interface IconifyIcon {
  body?: string
  parent?: string
  width?: number
  height?: number
  left?: number
  top?: number
  rotate?: number
  hFlip?: boolean
  vFlip?: boolean
}

// Iconify's default box, for a set that declares none.
const DEFAULT_SIZE = 16

// Every icon and alias of a set, by name.
export function iconNames(set: IconSet): string[] {
  return [...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})]
}

// The props an `svg` spreads to draw `name` of an iconify set, its box from the set and its markup inlined, aliases, flips and rotations applied: for an icon picked at runtime, from the set's JSON the app imports. Undefined when the set has no such icon.
export function iconProps(set: IconSet, name: string): IconProps | undefined {
  const icon = resolveIcon(set, name, 0)

  if (!icon?.body)
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

  if (icon.rotate)
    transforms.push(`rotate(${(icon.rotate % 4) * 90} ${left + width / 2} ${top + height / 2})`)

  return {
    'viewBox': `${left} ${top} ${width} ${height}`,
    'width': `${Math.round(width / height * 1000) / 1000}em`,
    'height': '1em',
    'aria-hidden': 'true',
    'innerHTML': transforms.length > 0 ? `<g transform="${transforms.join(' ')}">${icon.body}</g>` : icon.body,
  }
}

// An alias takes its parent's body and box, its own fields winning; flips toggle and rotations add up along the chain.
function resolveIcon(set: IconSet, name: string, depth: number): IconifyIcon | undefined {
  const own = set.icons[name]

  if (own)
    return own

  const alias = set.aliases?.[name]

  if (!alias?.parent || depth > 8)
    return undefined

  const parent = resolveIcon(set, alias.parent, depth + 1)

  if (!parent)
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
