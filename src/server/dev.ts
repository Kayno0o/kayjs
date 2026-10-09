import type { KayCompileError } from '../build/transform'
import type { HotSwap } from '../runtime/client'
import type { ClientBuild } from './client'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { compileErrorPage } from './overlay'

export const DEV_EVENTS = '/_kay/dev/events'
const BACKSLASH = /\\/g
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?|json|css)$/

// One per server process: `kay dev` restarts the process on every change, so a new id means new code.
const BOOT_ID = crypto.randomUUID()

// Reconnects once the restarted server is up: one running the code this page came from, restarted for a stylesheet, gets the page's stylesheets swapped in, one at a time; one running new code refreshes the page through the swap, which keeps the scroll and the islands whose props did not change, and loads the page fully when the swap cannot apply it, as after a new island. A page with no swap, or a server that failed to boot, reloads.
// The old links go once the new ones loaded, so the page never shows unstyled, and a page that no longer answers as it did reloads instead.
// A server restarted for edited islands only also names their new chunks: a page on the code it replaced swaps them in through `$kayHot`, keeping its state, then its stylesheets.
export const LIVE_RELOAD = `<script>(()=>{let b=${JSON.stringify(BOOT_ID)},v,q=Promise.resolve();new EventSource(${JSON.stringify(DEV_EVENTS)}).addEventListener('boot',e=>q=q.then(async()=>{const d=e.data,s=d.indexOf(' '),t=d.indexOf(' ',s+1),i=d.slice(0,s),c=t<0?d.slice(s+1):d.slice(s+1,t),h=t<0?null:JSON.parse(d.slice(t+1));if(i===b){v??=c;return}if(c!==v){let ok=false;try{ok=!!h&&String(h.from)===v&&!!window.$kayHot&&await window.$kayHot(h)}catch{}if(!ok){if(c===i||!window.$kayRefresh)return location.reload();try{await window.$kayRefresh()}catch{return location.reload()}}v=c}b=i;try{const r=await fetch(location.href);if(!r.ok||r.redirected)return location.reload();const d=new DOMParser().parseFromString(await r.text(),'text/html'),o=[...document.querySelectorAll('link[rel=stylesheet]')],u=new Set(o.map(l=>l.getAttribute('href')));await Promise.all([...d.querySelectorAll('link[rel=stylesheet]')].map(l=>new Promise(r=>{const k=document.createElement('link'),h=l.getAttribute('href');k.rel='stylesheet';k.href=u.has(h)?h+(h.includes('?')?'&':'?')+'kay-dev='+i:h;k.onload=k.onerror=r;document.head.append(k)})));for(const l of o)l.remove()}catch{location.reload()}}))})()</script>`

// Shows each problem kay logs in the browser, as `[kay] ...`, in a panel on the page as well as in the console; its own shadow root keeps the page's styles off it, and styles set through `style` pass a policy without inline styles.
// The problems `kay check` would report of the project's components, without type checking, come in a data block the page carries, and show once it loads. A page swap takes the panel away with the body, so the next one lists the new page's problems only. It updates in a microtask, so a failure of its own never breaks the call that logged.
export const DEV_PROBLEMS = `<script>(()=>{let h,t,c;const s=new Set,a=(n,k)=>{const e=document.createElement(n);e.style.cssText=k;return e},show=m=>{if(h?.isConnected){if(s.has(m))return}else{s.clear();h=a('kay-problems','position:fixed;left:1rem;right:1rem;bottom:1rem;z-index:2147483647;max-height:50vh;overflow:auto;padding:1rem;border:1px solid #b00020;background:#fff;color:#1a1a1a;font:14px/1.5 ui-monospace,monospace;text-align:left');const r=h.attachShadow({mode:'open'}),d=a('div','display:flex;justify-content:space-between;align-items:baseline;gap:1rem'),b=a('button','font:inherit;padding:.25rem .75rem;border:1px solid #ddd;background:#fff;color:inherit;cursor:pointer');t=a('strong','color:#b00020');c=a('div','');b.textContent='Dismiss';b.onclick=()=>h.remove();d.append(t,b);r.append(d,c);document.body.append(h)}s.add(m);const p=a('pre','margin:.75rem 0 0;padding:.75rem;border:1px solid #ddd;white-space:pre-wrap');p.textContent=m;c.append(p);t.textContent=s.size+' kay problem'+(s.size===1?'':'s')};addEventListener('DOMContentLoaded',()=>{for(const m of JSON.parse(document.getElementById('kay-check-problems')?.textContent||'[]'))show(m)});for(const k of['error','warn']){const o=console[k];console[k]=(...x)=>{o.apply(console,x);if(typeof x[0]==='string'&&x[0].startsWith('[kay] '))queueMicrotask(()=>{try{show(x[0].slice(6))}catch{}})}}})()</script>`

// Only islands changed since the last server started: a change to anything else, a page, a module or a startup file, reloads the pages; so does a list too long to pass on.
// Each swaps in with every island whose chunks hold its code; a chunk the page never loaded may come too when it holds nothing but edited islands, as Bun moves an island another one embeds into a chunk of its own.
export function hotSwap(root: string, client: ClientBuild): HotSwap | undefined {
  const from = process.env.KAY_DEV_FROM
  const changed = changedFiles(process.env.KAY_DEV_CHANGED)
  const inputs = client.chunkInputs

  if (from === undefined || !changed || !inputs)
    return undefined

  const edited = new Set<string>()

  for (const file of changed) {
    const id = file.replace(BACKSLASH, '/')

    if (statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile()) {
      if (!client.islands[id])
        return undefined

      edited.add(id)
    }
    // A file gone since: an editor's temporary one changed nothing, a deleted source file changed the pages.
    else if (SOURCE_FILE.test(id) && !basename(id).startsWith('.')) {
      return undefined
    }
  }

  const islands = Object.fromEntries(Object.entries(client.islands).filter(([, chunks]) => chunks.some(chunk => inputs[chunk]?.some(input => edited.has(input)))))
  const fresh = Object.values(islands).flat().filter(chunk => inputs[chunk]!.length > 0 && inputs[chunk]!.every(input => edited.has(input)))

  return Object.keys(islands).length === 0 ? undefined : { from: Number(from), islands, fresh: [...new Set(fresh)], entry: client.entry }
}

function changedFiles(text: string | undefined): string[] | undefined {
  try {
    const files = text === undefined ? undefined : JSON.parse(text) as unknown

    return Array.isArray(files) && files.every(file => typeof file === 'string') ? files : undefined
  }
  catch {
    return undefined
  }
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
  // Told by its name: the class's module loads the compiler, which a production server never needs.
  const html = compileErrorPage(error instanceof Error && error.name === 'KayCompileError' ? (error as KayCompileError).diagnostics : [], error) + LIVE_RELOAD

  const app = new Elysia({ name: 'kay/pages', seed })

  app.get(DEV_EVENTS, () => devEvents(true))
  app.get('/*', () => new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }))

  return app
}

// The data block `DEV_PROBLEMS` reads: a script of another type never runs, so the policy has nothing to allow.
export function problemsBlock(problems: string[] | undefined): string {
  return problems && problems.length > 0 ? `<script type="application/json" id="kay-check-problems">${JSON.stringify(problems).replaceAll('<', '\\u003c')}</script>` : ''
}
