// <Region>: a part of a page that a link or form can swap alone. A request naming a region renders only that one, and the others never read their children.

import type { RegionProps } from '../context'
import type { Html, KayChild } from '../jsx-runtime'
import type { PendingChunk, RenderContext, SettledChunk } from './context'
import { currentRenderContext, isInTarget, runInTarget } from './context'
import { escAttr, raw, ssrChild, ssrSpread } from './index'

const TAG_RE = /^[a-z][a-z0-9-]*$/
const DEFAULT_REGION_STREAM_TIMEOUT = 30_000
const KAY_S_TAG_RE = /<(\/?)kay-s(?=\s|>)/g

// The requested region's children render with `inTarget` set, so the regions inside it come out in full.
function renderTarget(ctx: RenderContext, children: () => KayChild): string {
  return runInTarget(ctx, () => ssrChild(children()))
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
    ctx.regionNames.add(name)
    if (ctx.region !== undefined && !isInTarget(ctx)) {
      if (ctx.region === name)
        ctx.regionHtml = renderTarget(ctx, () => props.children)
      else if (ctx.regionAncestors.has(name))
        ssrChild(props.children)
      return raw('')
    }
  }
  const inner = ssrChild(props.children)
  // Copied key by key: spreading `props` would read `children`, a lazy getter the other regions must never trigger.
  const attributes: Record<string, unknown> = {}
  for (const key of Object.keys(props)) {
    if (key !== 'name' && key !== 'as' && key !== 'children')
      attributes[key] = props[key]
  }
  return raw(`<${as} data-kay-region="${escAttr(name)}"${ssrSpread(attributes)}>${inner}</${as}>`)
}

function findPlaceholderRange(html: string, id: number): [number, number] | undefined {
  const openTag = `<kay-s id="k-s-${id}">`
  const start = html.indexOf(openTag)
  if (start === -1)
    return undefined
  let depth = 1
  KAY_S_TAG_RE.lastIndex = start + openTag.length
  let match: RegExpExecArray | null
  while ((match = KAY_S_TAG_RE.exec(html)) !== null) {
    if (match[1] === '/') {
      depth--
      if (depth === 0) {
        const closeEnd = html.indexOf('>', match.index)
        return closeEnd === -1 ? undefined : [start, closeEnd + 1]
      }
    }
    else {
      depth++
    }
  }
  return undefined
}

export interface FinishRegionOptions {
  streamTimeout?: number | undefined
  onError?: ((error: unknown) => void) | undefined
  runInScope?: (<T>(fn: () => T) => T) | undefined
}

async function settleChunkWithin(
  chunk: PendingChunk,
  deadline: number,
  streamTimeout: number,
  runInScope: <T>(fn: () => T) => T,
): Promise<SettledChunk> {
  const remaining = Math.max(0, deadline - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<SettledChunk>((resolve) => {
    timer = setTimeout(() => {
      const error = new Error(`<Suspense> boundary ${chunk.id} did not resolve within ${streamTimeout} ms`)
      resolve({ html: runInScope(() => chunk.renderError(error)), error })
    }, remaining)
  })
  try {
    return await Promise.race([chunk.settled, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

async function awaitRegionDiscovery(
  ctx: RenderContext,
  deadline: number,
  onError: ((error: unknown) => void) | undefined,
  runInScope: <T>(fn: () => T) => T,
): Promise<void> {
  const watched = new Set<number>()
  let pendingCount = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (done)
        return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const watchNew = () => {
      for (let i = 0; i < ctx.pending.length; i++) {
        const chunk = ctx.pending[i]!
        if (watched.has(chunk.id))
          continue
        watched.add(chunk.id)
        pendingCount++
        void chunk.settled.then((settled) => {
          pendingCount--
          if (done)
            return
          if ('error' in settled && onError !== undefined)
            runInScope(() => onError(settled.error))
          if (ctx.regionHtml !== undefined) {
            finish()
            return
          }
          watchNew()
          if (pendingCount === 0)
            finish()
        })
      }
    }
    timer = setTimeout(finish, Math.max(0, deadline - Date.now()))
    watchNew()
    if (ctx.regionHtml !== undefined || pendingCount === 0)
      finish()
  })
}

/** The requested region's HTML with its `<Suspense>` boundaries resolved in place, or `undefined` when the page rendered no such region. */
export async function finishRegion(ctx: RenderContext, options?: FinishRegionOptions): Promise<string | undefined> {
  const streamTimeout = options?.streamTimeout ?? DEFAULT_REGION_STREAM_TIMEOUT
  const onError = options?.onError
  const runInScope = options?.runInScope ?? (<T>(fn: () => T) => fn())
  const deadline = Date.now() + streamTimeout

  if (ctx.regionHtml === undefined && ctx.pending.length > 0)
    await awaitRegionDiscovery(ctx, deadline, onError, runInScope)

  let html = ctx.regionHtml
  if (html === undefined)
    return undefined
  for (let i = 0; i < ctx.pending.length; i++) {
    const chunk = ctx.pending[i]!
    const range = findPlaceholderRange(html, chunk.id)
    if (range === undefined)
      continue
    const settled = await settleChunkWithin(chunk, deadline, streamTimeout, runInScope)
    if ('error' in settled && onError !== undefined)
      runInScope(() => onError(settled.error))
    html = html.slice(0, range[0]) + settled.html + html.slice(range[1])
  }
  return html
}
