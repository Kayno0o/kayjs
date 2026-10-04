import { Elysia } from 'elysia'
import { KayCompileError } from '../build/transform'
import { compileErrorPage } from './overlay'

export const DEV_EVENTS = '/_kay/dev/events'

// One per server process: `kay dev` restarts the process on every change, so a new id means new code.
const BOOT_ID = crypto.randomUUID()

// Reconnects once the restarted server is up. A server running the code this page came from, restarted for a stylesheet, gets the page's stylesheets swapped for its own; any other one reloads it.
// An unchanged URL, a public file's, is fetched again; the old links go once the new ones loaded, so the page never shows unstyled.
export const LIVE_RELOAD = `<script>(()=>{let b=${JSON.stringify(BOOT_ID)},v;new EventSource(${JSON.stringify(DEV_EVENTS)}).addEventListener('boot',async e=>{const[i,c]=e.data.split(' ');if(i===b){v??=c;return}if(c!==v)return location.reload();b=i;try{const d=new DOMParser().parseFromString(await(await fetch(location.href)).text(),'text/html'),o=[...document.querySelectorAll('link[rel=stylesheet]')],u=new Set(o.map(l=>l.getAttribute('href')));await Promise.all([...d.querySelectorAll('link[rel=stylesheet]')].map(l=>new Promise(r=>{const k=document.createElement('link'),h=l.getAttribute('href');k.rel='stylesheet';k.href=u.has(h)?h+(h.includes('?')?'&':'?')+'kay-dev='+i:h;k.onload=k.onerror=r;document.head.append(k)})));for(const l of o)l.remove()}catch{location.reload()}})})()</script>`

// The stream stays open until the process exits; `retry` makes the browser poll quickly for the next one.
export function devEvents(): Response {
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`retry: 100\nevent: boot\ndata: ${BOOT_ID} ${process.env.KAY_DEV_CODE ?? BOOT_ID}\n\n`)
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

// What a dev server serves when the project failed to boot: the errors on every page, until a fix restarts it.
export function bootFailure(error: unknown, seed: string): Elysia {
  const html = compileErrorPage(error instanceof KayCompileError ? error.diagnostics : [], error) + LIVE_RELOAD

  const app = new Elysia({ name: 'kay/pages', seed })

  app.get(DEV_EVENTS, devEvents)
  app.get('/*', () => new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }))

  return app
}
