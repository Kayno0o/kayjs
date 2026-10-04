import type { ClientBuild } from './client'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { KayCompileError } from '../build/transform'
import { compileErrorPage } from './overlay'

export const DEV_EVENTS = '/_kay/dev/events'
const BACKSLASH = /\\/g

// One per server process: `kay dev` restarts the process on every change, so a new id means new code.
const BOOT_ID = crypto.randomUUID()

// Reconnects once the restarted server is up: one running the code this page came from, restarted for a stylesheet, gets the page's stylesheets swapped in, one at a time; anything else reloads it.
// The old links go once the new ones loaded, so the page never shows unstyled, and a page that no longer answers as it did reloads instead.
// A server restarted for edited islands only also names their new chunks: a page on the code it replaced swaps them in through `$kayHot`, keeping its state, then its stylesheets.
export const LIVE_RELOAD = `<script>(()=>{let b=${JSON.stringify(BOOT_ID)},v,q=Promise.resolve();new EventSource(${JSON.stringify(DEV_EVENTS)}).addEventListener('boot',e=>q=q.then(async()=>{const d=e.data,s=d.indexOf(' '),t=d.indexOf(' ',s+1),i=d.slice(0,s),c=t<0?d.slice(s+1):d.slice(s+1,t),h=t<0?null:JSON.parse(d.slice(t+1));if(i===b){v??=c;return}if(c!==v){let ok=false;try{ok=!!h&&String(h.from)===v&&!!window.$kayHot&&await window.$kayHot(h)}catch{}if(!ok)return location.reload();v=c}b=i;try{const r=await fetch(location.href);if(!r.ok||r.redirected)return location.reload();const d=new DOMParser().parseFromString(await r.text(),'text/html'),o=[...document.querySelectorAll('link[rel=stylesheet]')],u=new Set(o.map(l=>l.getAttribute('href')));await Promise.all([...d.querySelectorAll('link[rel=stylesheet]')].map(l=>new Promise(r=>{const k=document.createElement('link'),h=l.getAttribute('href');k.rel='stylesheet';k.href=u.has(h)?h+(h.includes('?')?'&':'?')+'kay-dev='+i:h;k.onload=k.onerror=r;document.head.append(k)})));for(const l of o)l.remove()}catch{location.reload()}}))})()</script>`

// What a page on the code the last server started with swaps in rather than reloading: the chunks of each island changed since, by island, its own first.
export interface HotSwap {
  from: number
  islands: Record<string, string[]>
  // The new entry, which the page then counts as its own, so a page swapped in later is not taken for another build.
  entry?: string
}

// Only islands changed since the last server started: a change to anything else, a page, a module or a startup file, reloads the pages. A file gone since, as an editor's temporary one, changed nothing.
// Each changed island swaps in with every other island whose chunks hold its code, as one rendering it inside.
export function hotSwap(root: string, client: ClientBuild): HotSwap | undefined {
  const from = process.env.KAY_DEV_FROM
  const changed = process.env.KAY_DEV_CHANGED

  if (from === undefined || changed === undefined || !client.islandInputs)
    return undefined

  const islands: Record<string, string[]> = {}

  for (const file of JSON.parse(changed) as string[]) {
    if (!statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile())
      continue

    const id = file.replace(BACKSLASH, '/')

    if (!client.islands[id])
      return undefined

    for (const [island, inputs] of Object.entries(client.islandInputs)) {
      if (inputs.includes(id))
        islands[island] = client.islands[island]!
    }
  }

  return Object.keys(islands).length === 0 ? undefined : { from: Number(from), islands, entry: client.entry }
}

// The stream stays open until the process exits; `retry` makes the browser poll quickly for the next one.
// A server that failed to boot gives its own id as its code, so the pages on either side of it always reload.
export function devEvents(failed = false, hot?: HotSwap): Response {
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`retry: 100\nevent: boot\ndata: ${BOOT_ID} ${failed ? BOOT_ID : process.env.KAY_DEV_CODE ?? BOOT_ID}${hot && !failed ? ` ${JSON.stringify(hot)}` : ''}\n\n`)
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

// What a dev server serves when the project failed to boot: the errors on every page, until a fix restarts it.
export function bootFailure(error: unknown, seed: string): Elysia {
  const html = compileErrorPage(error instanceof KayCompileError ? error.diagnostics : [], error) + LIVE_RELOAD

  const app = new Elysia({ name: 'kay/pages', seed })

  app.get(DEV_EVENTS, () => devEvents(true))
  app.get('/*', () => new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }))

  return app
}
