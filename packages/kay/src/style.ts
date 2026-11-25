// The CSS text of a style object, shared by the server and the browser so both render the same declarations.

// Properties that take a bare number; any other number gets `px`.
const UNITLESS = new Set([
  'animation-iteration-count', 'aspect-ratio', 'border-image-outset', 'border-image-slice', 'border-image-width',
  'column-count', 'columns', 'fill-opacity', 'flex', 'flex-grow', 'flex-shrink', 'flood-opacity', 'font-weight',
  'grid-area', 'grid-column', 'grid-column-end', 'grid-column-start', 'grid-row', 'grid-row-end', 'grid-row-start',
  'line-clamp', '-webkit-line-clamp', 'line-height', 'opacity', 'order', 'orphans', 'scale', 'stop-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'tab-size',
  'widows', 'z-index', 'zoom',
])
const UPPER = /[A-Z]/g
const MS_PREFIX = /^ms[A-Z]/

// `backgroundColor` becomes `background-color` and `msTransform` `-ms-transform`; a custom property keeps its case.
function cssName(key: string): string {
  if (key.startsWith('--'))
    return key
  const name = key.replace(UPPER, c => `-${c.toLowerCase()}`)
  return MS_PREFIX.test(key) ? `-${name}` : name
}

export function styleText(style: Record<string, unknown>): string {
  let out = ''
  for (const [key, value] of Object.entries(style)) {
    if (value == null || value === '' || value === false)
      continue
    const name = cssName(key)
    const px = typeof value === 'number' && !name.startsWith('--') && !UNITLESS.has(name)
    out += `${name}:${value}${px ? 'px' : ''};`
  }
  return out
}
