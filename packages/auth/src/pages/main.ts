import type { PageHook } from 'kay/server'

const MARKER = ' data-kayjs-main'
const MAIN = /<main[\s>]|\srole=["']?main\b/gi
const MARKER_ATTRIBUTE = / data-kayjs-main(?:="")?/

// The prebuilt pages write their own `main`, marked `data-kayjs-main`. An app whose layout already wraps its pages in one keeps that landmark alone and the page's becomes a `div`, as a page holds a single `main`; the marker goes either way.
export const dropNestedMain: PageHook = ({ html }) => {
  if (!html.includes(MARKER))
    return html

  const marked = [...html.matchAll(/<main\b[^>]*? data-kayjs-main[^>]*>/g)].length
  const nested = [...html.matchAll(MAIN)].length > marked
  let out = html
  let from = 0

  for (;;) {
    const at = out.indexOf('<main', from)

    if (at === -1)
      break

    const end = out.indexOf('>', at)
    const tag = out.slice(at, end + 1)

    if (!tag.includes(MARKER)) {
      from = end

      continue
    }

    const open = tag.replace(MARKER_ATTRIBUTE, '')

    if (!nested) {
      out = out.slice(0, at) + open + out.slice(end + 1)
      from = at + open.length

      continue
    }

    const close = out.indexOf('</main>', end)
    const inner = out.slice(end + 1, close === -1 ? undefined : close)
    const rest = close === -1 ? '' : out.slice(close + '</main>'.length)

    out = `${out.slice(0, at)}<div${open.slice('<main'.length)}${inner}${close === -1 ? '' : '</div>'}${rest}`
    from = at + 1
  }

  return out
}
