import type { PendingBlock } from '../runtime/await.server'
import type { RenderedIslands } from '../runtime/island.server'
import type { SnapshotReader } from '../runtime/snapshots'
import type { ClientBuild } from './client'
import { collectDeferred } from '../runtime/await.server'
import { child } from '../runtime/html'
import { collectIslands } from '../runtime/island.server'
import { isSnapshots, lastSnapshot, readSnapshots } from '../runtime/snapshots'
import { hydrationScript } from './hydration'
import { messagesScript } from './i18n'

// Swaps every streamed block that arrived in for the pending one between its markers, then hydrates the islands they brought; an outer block that settled first may have taken the markers away already.
// Both scripts are the same on every page, so a Content-Security-Policy allows them by hash.
export const SWAP_SCRIPT = 'function $kayAwait(){for(var t of document.querySelectorAll("template[data-kay-await]")){var i=t.dataset.kayAwait,w=document.createTreeWalker(document.body,128),s=null,n;while(n=w.nextNode())if(n.data=="kay-await:"+i){s=n;break}if(s){while((n=s.nextSibling)&&!(n.nodeType==8&&n.data=="/kay-await:"+i))n.remove();n&&n.remove();s.replaceWith(t.content)}t.remove()}self.$kayHydrate&&$kayHydrate()}'
export const SWAP_CALL = '$kayAwait()'
const encoder = new TextEncoder()
const EMPTY: Rendered = { html: '', islands: { eager: new Set(), count: 0, messages: new Set() }, deferred: [] }

export interface Rendered {
  html: string
  islands: RenderedIslands
  deferred: PendingBlock[]
}

// A static render, as pages and layouts are: only islands carry the markers hydration claims.
export function renderStatic(view: () => unknown, salt?: string): Rendered {
  const { result: { result: html, islands }, deferred } = collectDeferred(() => collectIslands(() => child(view()), salt))

  return { html, islands, deferred }
}

// Bun closes a connection idle for 10 s by default, and proxies after a minute or so: an empty comment now and then keeps a page whose blocks are slow open.
export const KEEP_ALIVE_MS = 5000
const KEEP_ALIVE = encoder.encode('<!---->')

// Each part of an iterable goes out as the whole block again, so parts coming faster than this are sent as the latest of them.
export const PART_MS = 50

// Sends the page up to its last pending block at once, then each block as it settles, in whatever order they do.
export function streamDocument(shell: string, deferred: PendingBlock[], client: ClientBuild, entryShipped: boolean, report: (error: unknown) => void): ReadableStream<Uint8Array> {
  let shipped = entryShipped
  let swapShipped = false
  // Once the browser goes away, blocks still settling render nothing.
  let cancelled = false
  let keepAlive: ReturnType<typeof setInterval> | undefined
  // The iterables being read, stopped when the browser goes away.
  const readers = new Set<SnapshotReader>()

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(shell))
      keepAlive = setInterval(() => controller.enqueue(KEEP_ALIVE), KEEP_ALIVE_MS)

      // A part sent while more may come keeps its markers around it, for the next part to replace.
      const write = (id: string, rendered: Rendered, more: boolean): void => {
        let scripts = swapShipped ? '' : `<script>${SWAP_SCRIPT}</script>`

        swapShipped = true

        if (rendered.islands.count > 0) {
          // The first part with islands carries the locale; later ones only the messages they bring.
          scripts += messagesScript(rendered.islands.messages, !shipped)

          if (!shipped && client.entry !== undefined) {
            scripts += `${hydrationScript}<script type="module" async src="${client.entry}"></script>`
            shipped = true
          }
        }

        const html = more ? `<!--kay-await:${id}-->${rendered.html}<!--/kay-await:${id}-->` : rendered.html

        controller.enqueue(encoder.encode(`<template data-kay-await="${id}">${html}</template>${scripts}<script>${SWAP_CALL}</script>`))
      }

      const send = async (block: PendingBlock): Promise<void> => {
        if (isSnapshots(block.value))
          return sendParts(block, block.value)

        const rendered = await settle(block, () => cancelled, report)

        if (cancelled)
          return

        write(block.id, rendered, false)
        await Promise.all(rendered.deferred.map(send))
      }

      // Each part renders `then` in place of the last, an `await` inside it showing its pending block until the last part, whose blocks stream as any do.
      async function sendParts(block: PendingBlock, source: AsyncIterable<unknown>): Promise<void> {
        let shown = false
        let broken = false
        const reader = readSnapshots(source, PART_MS, (value) => {
          if (cancelled || broken)
            return

          const rendered = renderOrReport(() => block.ready(value as never), report, renderStatic, block.id)

          // A `then` block that throws is a bug in the page: the iterable is not read further.
          if (rendered === EMPTY) {
            broken = true
            reader.stop()
          }

          drop(rendered.deferred)
          write(block.id, rendered, !broken)
          shown = true
        })
        let last: { value: unknown } | undefined

        readers.add(reader)

        try {
          last = await reader.done
        }
        catch (error) {
          if (cancelled || broken)
            return

          if (!block.failed) {
            report(error)

            // What came before the failure stays; with nothing shown yet, the pending block goes.
            if (!shown)
              write(block.id, EMPTY, false)

            return
          }

          const failed = block.failed
          const rendered = renderOrReport(() => failed(error), report, renderStatic, block.id)

          write(block.id, rendered, false)
          await Promise.all(rendered.deferred.map(send))

          return
        }
        finally {
          readers.delete(reader)
        }

        if (cancelled || broken)
          return

        // An iterable ending with no value leaves nothing in place of its pending block.
        const rendered = last ? renderOrReport(() => block.ready(last.value as never), report, renderStatic, block.id) : EMPTY

        write(block.id, rendered, false)
        await Promise.all(rendered.deferred.map(send))
      }

      try {
        await Promise.all(deferred.map(send))
      }
      finally {
        clearInterval(keepAlive)
      }

      if (cancelled)
        return

      controller.enqueue(encoder.encode('</body></html>'))
      controller.close()
    },
    cancel() {
      cancelled = true
      clearInterval(keepAlive)

      for (const reader of readers)
        reader.stop()
    },
  })
}

// The `then` block once the value resolves, or with an iterable's last part, or the `catch` block once it rejects; without one, the pending block just goes away and the error is reported.
// A block that throws while rendering is a bug in the page, not the value failing, so it is reported rather than shown as `catch`.
export async function settle(block: PendingBlock, cancelled: () => boolean, report: (error: unknown) => void, render: (view: () => unknown, salt?: string) => Rendered = renderStatic): Promise<Rendered> {
  let value: { value: unknown } | undefined

  try {
    value = await lastSnapshot(block.value)
  }
  catch (error) {
    if (!block.failed) {
      report(error)

      return EMPTY
    }

    const failed = block.failed

    return renderOrReport(() => failed(error), report, render, block.id)
  }

  if (cancelled() || value === undefined)
    return EMPTY

  const last = value.value

  return renderOrReport(() => block.ready(last as never), report, render, block.id)
}

// The blocks a part left pending never stream, as the next part replaces them: a promise among them is taken, so its rejection crashes nothing, and an iterable left unread.
function drop(blocks: PendingBlock[]): void {
  for (const block of blocks) {
    if (block.value instanceof Promise)
      void Promise.allSettled([block.value])
  }
}

function renderOrReport(view: () => unknown, report: (error: unknown) => void, render: (view: () => unknown, salt?: string) => Rendered, salt: string): Rendered {
  try {
    return render(view, salt)
  }
  catch (error) {
    report(error)

    return EMPTY
  }
}
