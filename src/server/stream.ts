import type { Action } from '../runtime/action'
import type { PendingBlock } from '../runtime/await.server'
import type { RenderedIslands } from '../runtime/island.server'
import type { SnapshotReader } from '../runtime/snapshots'
import type { ClientBuild } from './client'
import { collectForms } from '../runtime/action'
import { collectDeferred } from '../runtime/await.server'
import { child } from '../runtime/html'
import { collectIslands } from '../runtime/island.server'
import { isSnapshots, lastSnapshot, readSnapshots } from '../runtime/snapshots'
import { formsScript } from './forms'
import { hydrationScript } from './hydration'
import { invalidKeys, messagesScript } from './i18n'
import { workScript } from './work'

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
  // The actions the forms of a streamed block post to.
  forms?: Set<Action<never, unknown>>
}

// What the shell already sent, which a streamed block does not send again.
export interface Shipped {
  // The hydration script, which queues the events islands miss before they hydrate.
  hydration?: boolean
  // The actions whose schemas the shell's forms script holds.
  forms?: Set<Action<never, unknown>> | undefined
  // Whether the `kay.invalid.*` messages went with the locale.
  words?: boolean
  // Whether the page's locale went, which the first messages script carries.
  locale?: boolean
  // Whether `kay dev` reads the rules again each time.
  dev?: boolean | undefined
}

// A static render, as pages and layouts are: only islands carry the markers hydration claims.
export function renderStatic(view: () => unknown, salt?: string): Rendered {
  const { result: { result: html, islands }, deferred } = collectDeferred(() => collectIslands(() => child(view()), salt))

  return { html, islands, deferred }
}

// A streamed block, whose forms are collected for the stream to send their schemas along as the shell would have.
export function renderBlock(view: () => unknown, salt?: string): Rendered {
  const { result, forms } = collectForms(() => renderStatic(view, salt))

  return { ...result, forms }
}

// What a block settled inside a server island sends for its forms, as the shell of a page would: the schemas, the challenges and the words the browser's check uses; the browser merges every such script it finds.
export function formChecks(forms: Set<Action<never, unknown>> | undefined, dev?: boolean): string {
  if (!forms || forms.size === 0)
    return ''

  const checked = formsScript(forms, dev)

  return checked + workScript(forms, false) + (checked === '' ? '' : messagesScript(new Set(invalidKeys()), true))
}

// Bun closes a connection idle for 10 s by default, and proxies after a minute or so: an empty comment now and then keeps a page whose blocks are slow open.
export const KEEP_ALIVE_MS = 5000
const KEEP_ALIVE = encoder.encode('<!---->')

// Each part of an iterable goes out as the whole block again, so parts coming faster than this are sent as the latest of them.
export const PART_MS = 50

// Sends the page up to its last pending block at once, then each block as it settles, in whatever order they do.
export function streamDocument(shell: string, deferred: PendingBlock[], client: ClientBuild, entryShipped: boolean, report: (error: unknown) => void, sent: Shipped = {}): ReadableStream<Uint8Array> {
  let shipped = entryShipped
  let hydrationShipped = sent.hydration ?? entryShipped
  let wordsShipped = sent.words ?? false
  let localeShipped = sent.locale ?? entryShipped
  const formsShipped = new Set(sent.forms)
  // A page without navigation has no entry to send a form with.
  const posts = client.entry !== undefined && client.navigation === true
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

        const fresh = posts ? [...rendered.forms ?? []].filter(form => !formsShipped.has(form)) : []
        const checked = fresh.length > 0 ? formsScript(new Set(fresh), sent.dev) : ''
        // The challenges the shell lacks go the same way, the browser reading every challenges script.
        const worked = fresh.length > 0 ? workScript(new Set(fresh), false) : ''

        for (const form of fresh)
          formsShipped.add(form)

        const keys = new Set(rendered.islands.messages)

        // The browser's form check words a refusal as the server does, so the first checked form sends the `kay.invalid.*` messages too.
        if (checked !== '' && !wordsShipped) {
          for (const key of invalidKeys())
            keys.add(key)

          wordsShipped = true
        }

        scripts += checked + worked

        // The first message of the page carries the locale; later ones only the messages they bring.
        if (rendered.islands.count > 0 || (checked !== '' && keys.size > 0)) {
          scripts += messagesScript(keys, !localeShipped)
          localeShipped = true
        }

        if (rendered.islands.count > 0 && !hydrationShipped) {
          scripts += hydrationScript
          hydrationShipped = true
        }

        if (!shipped && client.entry !== undefined && (rendered.islands.count > 0 || checked !== '' || worked !== '')) {
          scripts += `<script type="module" async src="${client.entry}"></script>`
          shipped = true
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

          const rendered = renderOrReport(() => block.ready(value as never), report, renderBlock, block.id)

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
          const rendered = renderOrReport(() => failed(error), report, renderBlock, block.id)

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
        const rendered = last ? renderOrReport(() => block.ready(last.value as never), report, renderBlock, block.id) : EMPTY

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
export async function settle(block: PendingBlock, cancelled: () => boolean, report: (error: unknown) => void, render: (view: () => unknown, salt?: string) => Rendered = renderBlock): Promise<Rendered> {
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
