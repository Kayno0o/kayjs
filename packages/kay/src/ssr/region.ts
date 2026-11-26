// <Region>: a part of a page that a link or form can swap alone. A request naming a region renders only that one, and the others never read their children.

import type { RegionProps } from '../context'
import type { Html, KayChild } from '../jsx-runtime'
import type { RenderContext } from './context'
import { currentRenderContext } from './context'
import { escAttr, raw, ssrChild, ssrSpread } from './index'

const TAG_RE = /^[a-z][a-z0-9-]*$/

function renderChildren(ctx: RenderContext | undefined, name: string, children: () => KayChild): string {
  if (ctx === undefined)
    return ssrChild(children())
  ctx.inRegion = name
  try {
    return ssrChild(children())
  }
  finally {
    ctx.inRegion = undefined
  }
}

export function Region(props: RegionProps): Html {
  const { name, as = 'div' } = props
  if (typeof name !== 'string' || name === '')
    throw new Error('kay: <Region> needs a name: write <Region name="pane">.')
  if (!TAG_RE.test(as))
    throw new Error(`kay: <Region name="${name}" as="${as}"> is not an element name: write as="section", for example.`)
  const ctx = currentRenderContext()
  if (ctx !== undefined) {
    if (ctx.regionNames.has(name))
      throw new Error(`kay: two <Region name="${name}"> on one page: give each region its own name.`)
    if (ctx.inRegion !== undefined)
      throw new Error(`kay: <Region name="${name}"> inside <Region name="${ctx.inRegion}">: put the two side by side.`)
    ctx.regionNames.add(name)
    if (ctx.region !== undefined) {
      if (ctx.region === name)
        ctx.regionHtml = renderChildren(ctx, name, () => props.children)
      return raw('')
    }
  }
  const inner = renderChildren(ctx, name, () => props.children)
  // Copied key by key: spreading `props` would read `children`, a lazy getter the other regions must never trigger.
  const attributes: Record<string, unknown> = {}
  for (const key of Object.keys(props)) {
    if (key !== 'name' && key !== 'as' && key !== 'children')
      attributes[key] = props[key]
  }
  return raw(`<${as} data-kay-region="${escAttr(name)}"${ssrSpread(attributes)}>${inner}</${as}>`)
}

const PLACEHOLDER = (id: number): RegExp => new RegExp(`<kay-s id="k-s-${id}">[\\s\\S]*?</kay-s>`)

/** The requested region's HTML with its `<Suspense>` boundaries resolved in place, or `undefined` when the page rendered no such region. */
export async function finishRegion(ctx: RenderContext): Promise<string | undefined> {
  let html = ctx.regionHtml
  if (html === undefined)
    return undefined
  for (let i = 0; i < ctx.pending.length; i++) {
    const chunk = ctx.pending[i]!
    const placeholder = PLACEHOLDER(chunk.id)
    if (!placeholder.test(html))
      continue
    const settled = await chunk.settled
    html = html.replace(placeholder, () => settled.html)
  }
  return html
}
