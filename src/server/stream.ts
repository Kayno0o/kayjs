import type { PendingBlock } from '../runtime/await.server'
import type { RenderedIslands } from '../runtime/island.server'
import type { ClientBuild } from './client'
import { collectDeferred } from '../runtime/await.server'
import { child } from '../runtime/html'
import { collectIslands } from '../runtime/island.server'
import { hydrationScript } from './hydration'

// Swaps every streamed block that arrived in for the pending one between its markers, then hydrates the islands they brought; an outer block that settled first may have taken the markers away already.
// Both scripts are the same on every page, so a Content-Security-Policy allows them by hash.
export const SWAP_SCRIPT = 'function $kayAwait(){for(var t of document.querySelectorAll("template[data-kay-await]")){var i=t.dataset.kayAwait,w=document.createTreeWalker(document.body,128),s=null,n;while(n=w.nextNode())if(n.data=="kay-await:"+i){s=n;break}if(s){while((n=s.nextSibling)&&!(n.nodeType==8&&n.data=="/kay-await:"+i))n.remove();n&&n.remove();s.replaceWith(t.content)}t.remove()}self.$kayHydrate&&$kayHydrate()}'
export const SWAP_CALL = '$kayAwait()'
const encoder = new TextEncoder()
const EMPTY: Rendered = { html: '', islands: { eager: new Set(), count: 0 }, deferred: [] }

export interface Rendered {
  html: string
  islands: RenderedIslands
  deferred: PendingBlock[]
}

// A static render, as pages and layouts are: only islands, rendered as their own Solid roots, carry hydration keys.
export function renderStatic(view: () => unknown): Rendered {
  const { result: { result: html, islands }, deferred } = collectDeferred(() => collectIslands(() => child(view())))

  return { html, islands, deferred }
}

// Sends the page up to its last pending block at once, then each block as it settles, in whatever order they do.
export function streamDocument(shell: string, deferred: PendingBlock[], client: ClientBuild, entryShipped: boolean, report: (error: unknown) => void): ReadableStream<Uint8Array> {
  let shipped = entryShipped
  let swapShipped = false
  // Once the browser goes away, blocks still settling render nothing.
  let cancelled = false

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(shell))

      const send = async (block: PendingBlock): Promise<void> => {
        const rendered = await settle(block, () => cancelled, report)

        if (cancelled)
          return

        let scripts = swapShipped ? '' : `<script>${SWAP_SCRIPT}</script>`

        swapShipped = true

        if (rendered.islands.count > 0 && !shipped && client.entry !== undefined) {
          scripts += `${hydrationScript}<script type="module" async src="${client.entry}"></script>`
          shipped = true
        }

        controller.enqueue(encoder.encode(`<template data-kay-await="${block.id}">${rendered.html}</template>${scripts}<script>${SWAP_CALL}</script>`))
        await Promise.all(rendered.deferred.map(send))
      }

      await Promise.all(deferred.map(send))

      if (cancelled)
        return

      controller.enqueue(encoder.encode('</body></html>'))
      controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
}

// The `then` block once the value resolves, or the `catch` block once it rejects; without one, the pending block just goes away and the error is reported.
// A block that throws while rendering is a bug in the page, not the value failing, so it is reported rather than shown as `catch`.
async function settle(block: PendingBlock, cancelled: () => boolean, report: (error: unknown) => void): Promise<Rendered> {
  let value: unknown

  try {
    value = await block.value
  }
  catch (error) {
    if (!block.failed) {
      report(error)

      return EMPTY
    }

    const failed = block.failed

    return renderOrReport(() => failed(error), report)
  }

  return cancelled() ? EMPTY : renderOrReport(() => block.ready(value as never), report)
}

function renderOrReport(view: () => unknown, report: (error: unknown) => void): Rendered {
  try {
    return renderStatic(view)
  }
  catch (error) {
    report(error)

    return EMPTY
  }
}
