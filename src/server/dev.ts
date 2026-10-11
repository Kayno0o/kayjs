import type { ClientOptions } from '../build/client'
import type { KayCompileError } from '../build/transform'
import type { BuildFailure } from '../dev/builder'
import type { HotSwap } from '../runtime/client'
import type { ClientBuild } from './client'
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Elysia } from 'elysia'
import { outputDir, underKayDev } from '../build/assets'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { BUILD_FAILURE, clientOptionsKey, fromManifest, readManifest } from './client'
import { editorCommand } from './editor'
import { compileErrorPage } from './overlay'

export const DEV_EVENTS = '/_kay/dev/events'
export const DEV_PATCH = '/_kay/dev/patch.js'
export const DEV_INSPECTOR = '/_kay/dev/inspector.js'
export const DEV_OPEN = '/_kay/dev/open'
export const DEV_A11Y = '/_kay/dev/a11y.js'
export const DEV_AXE = '/_kay/dev/axe.js'
const PATCH_SOURCE = resolve(import.meta.dir, '../runtime/dev-patch.ts')
const INSPECTOR_SOURCE = resolve(import.meta.dir, '../runtime/dev-inspector.ts')
const A11Y_SOURCE = resolve(import.meta.dir, '../runtime/dev-a11y.ts')
// What the inspector sends, which a page of another site cannot without a preflight nothing answers.
const OPEN_HEADER = 'x-kay-dev'
const POSITION = /^(.+\.kay):(\d+):(\d+)$/
const BACKSLASH = /\\/g
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?|json|css)$/

// One per server process: `kay dev` restarts the process on every change, so a new id means new code.
const BOOT_ID = crypto.randomUUID()
// The event streams open on this server, which a stylesheet edit is pushed to.
const streams = new Set<ReadableStreamDefaultController<string>>()

// Reconnects once the restarted server is up: one running the code this page came from, restarted for a stylesheet, gets the page's stylesheets swapped in, one at a time; one running new code refreshes the page through the swap, which keeps the scroll and the islands whose props did not change, and loads the page fully when the swap cannot apply it, as after a new island. A page with no swap, as under `navigation: false`, keeps the server render it loaded with and applies what changed between it and the new one to the page, through `DEV_PATCH`; it reloads when that cannot be applied, and a server that failed to boot always reloads.
// The old links go once the new ones loaded, so the page never shows unstyled, and a page that no longer answers as it did reloads instead. A stylesheet edit swaps them the same way without a restart, on a `styles` event.
// A server restarted for edited islands only also names their new chunks: a page on the code it replaced swaps them in through `$kayHot`, keeping its state, then its stylesheets.
// The id is a meta beside the script, so the script reads the same on every server: a page swap keeps it rather than running a copy that connects again, and a policy allows it by one hash.
export const LIVE_RELOAD = `<meta name="kay-boot" content="${BOOT_ID}"><script>(()=>{let b=document.querySelector('meta[name=kay-boot]')?.content,v,s,q=Promise.resolve();const load=async()=>{try{const r=await fetch(location.href,{cache:'no-store',headers:{accept:'text/html'}});return r.ok&&!r.redirected?new DOMParser().parseFromString(await r.text(),'text/html'):null}catch{return null}},css=async(d,i)=>{const o=[...document.querySelectorAll('link[rel=stylesheet]')],u=new Set(o.map(l=>l.getAttribute('href')));await Promise.all([...d.querySelectorAll('link[rel=stylesheet]')].map(l=>new Promise(r=>{const k=document.createElement('link'),h=l.getAttribute('href');k.rel='stylesheet';k.href=u.has(h)?h+(h.includes('?')?'&':'?')+'kay-dev='+i:h;k.onload=k.onerror=r;document.head.append(k)})));for(const l of o)l.remove()},x=new EventSource(${JSON.stringify(DEV_EVENTS)});x.addEventListener('styles',e=>q=q.then(async()=>{try{const d=await load();if(!d)return location.reload();if(s)s=d;await css(d,e.data)}catch{location.reload()}}));x.addEventListener('boot',e=>q=q.then(async()=>{let p=false;const d=e.data,s0=d.indexOf(' '),t=d.indexOf(' ',s0+1),i=d.slice(0,s0),c=t<0?d.slice(s0+1):d.slice(s0+1,t),h=t<0?null:JSON.parse(d.slice(t+1));if(i===b){v??=c;if(!window.$kayRefresh)s??=await load();return}if(c!==v){let ok=false;try{ok=!!h&&String(h.from)===v&&!!window.$kayHot&&await window.$kayHot(h)}catch{}if(!ok){if(c===i)return location.reload();if(window.$kayRefresh){try{await window.$kayRefresh()}catch{return location.reload()}}else p=true}v=c}b=i;try{const d=await load();if(!d)return location.reload();if(p){const m=await import(${JSON.stringify(DEV_PATCH)});if(!s||!m.patch(s,d))return location.reload();s=d}await css(d,i)}catch{location.reload()}}))})()</script>`

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

// The module a page without the page swap applies its refresh with, its TypeScript source stripped to what a browser runs.
let patchModule: string | undefined

export function devPatch(): Response {
  patchModule ??= new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(PATCH_SOURCE, 'utf8'))

  return new Response(patchModule, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
}

let inspectorModule: string | undefined

export function devInspector(): Response {
  inspectorModule ??= `${new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(INSPECTOR_SOURCE, 'utf8'))}\nstartInspector()\n`

  return new Response(inspectorModule, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
}

// Checks each page the dev server serves with axe-core once it settles, its violations showing in the problem panel.
export const A11Y_SCRIPT = `<script type="module" src="${DEV_A11Y}"></script>`

let a11yModule: string | undefined

export function devA11y(): Response {
  a11yModule ??= `${new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(A11Y_SOURCE, 'utf8'))}\nstartA11y()\n`

  return new Response(a11yModule, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
}

// Read where the dependency installed, never imported, so a compiled server leaves it out.
export function devAxe(): Response {
  return new Response(Bun.file(fileURLToPath(import.meta.resolve('axe-core/axe.min.js'))), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } })
}

// How long the editor command gets to fail before it counts as opened: a launcher such as `code -g` or `tmux new-window` exits at once, an editor keeping its process runs on.
const EDITOR_FAILS_WITHIN_MS = 2000

// Whether the editor command started and did not exit with an error, its errors going to the `kay dev` terminal.
async function launched(command: string[], cwd: string): Promise<boolean> {
  let editor: Bun.Subprocess

  try {
    editor = Bun.spawn(command, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
  }
  catch {
    return false
  }

  editor.unref()
  const code = await Promise.race([editor.exited, waited(EDITOR_FAILS_WITHIN_MS)])

  return code === undefined || code === 0
}

async function waited(ms: number): Promise<undefined> {
  await Bun.sleep(ms)

  return undefined
}

// Loads the inspector on the pages of a server `kay dev` started, the one whose elements carry their source position.
export function inspectorScript(): string {
  return underKayDev() ? `<script type="module" src="${DEV_INSPECTOR}"></script>` : ''
}

// Opens the `.kay` file at the position the inspector names, in the editor `editorCommand` finds; with none, the terminal prints the position.
export async function openInEditor(root: string, request: Request): Promise<Response> {
  if (request.headers.get(OPEN_HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  let source: unknown

  try {
    source = (await request.json() as { source?: unknown }).source
  }
  catch {
    return new Response(null, { status: 400 })
  }

  const [, file, line, column] = typeof source === 'string' ? POSITION.exec(source) ?? [] : []
  const path = file === undefined ? undefined : resolve(root, file)
  const inside = path !== undefined && !relative(root, path).startsWith('..') && !isAbsolute(relative(root, path))

  if (!inside || statSync(path, { throwIfNoEntry: false })?.isFile() !== true)
    return new Response(null, { status: 404 })

  const command = editorCommand(path, Number(line), Number(column))

  if (command === undefined) {
    console.log(`kay dev: ${file}:${line}:${column}, set KAY_EDITOR to open it from the page`)

    return Response.json({ opened: false })
  }

  if (await launched(command, root))
    return Response.json({ opened: true })

  console.log(`kay dev: ${command.join(' ')} failed to open ${file}:${line}:${column}`)

  return Response.json({ opened: false, failed: true })
}

// The stream stays open until the process exits; `retry` makes the browser poll quickly for the next one.
// A server that failed to boot gives its own id as its code, so the pages on either side of it always reload.
export function devEvents(failed = false, hot?: HotSwap): Response {
  let own: ReadableStreamDefaultController<string> | undefined
  const stream = new ReadableStream<string>({
    start(controller) {
      own = controller
      streams.add(controller)
      controller.enqueue(`retry: 100\nevent: boot\ndata: ${BOOT_ID} ${failed ? BOOT_ID : process.env.KAY_DEV_CODE ?? BOOT_ID}${hot && !failed ? ` ${JSON.stringify(hot)}` : ''}\n\n`)
    },
    cancel() {
      streams.delete(own!)
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

// What the build `kay dev` keeps holds, as a production server reads `kay build`'s, its stylesheets following each stylesheet edit; undefined when the server is to bundle its own, as when `pages()` was given other options than kay.config.ts holds.
export async function kayDevClient(root: string, options: ClientOptions): Promise<ClientBuild | undefined> {
  if (process.send === undefined)
    return undefined

  const answer = await askKayDev()

  if (answer === 'none')
    return undefined

  const key = clientOptionsKey(options)

  if (answer === 'failed') {
    const failure = await readFailure(root)

    if (failure?.options === key)
      throw failureError(failure)
  }
  else {
    const manifest = await readManifest(root)

    if (manifest?.options === key)
      return followStyles(root, fromManifest(root, manifest))
  }

  kayLog('warn', '`pages()` was given options for the browser build that kay.config.ts does not hold, so each server bundles it as it boots; move them to kay.config.ts for `kay dev` to build it ahead')
  process.send({ ownClient: true })

  return undefined
}

// `kay dev` answers once its build is done: `built`, `failed`, or `none` when it has none for this server.
async function askKayDev(): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const answered = (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'client' in message && typeof message.client === 'string') {
      process.off('message', answered)
      resolve(message.client)
    }
  }

  process.on('message', answered)
  process.send!({ wantsClient: true })

  return promise
}

async function readFailure(root: string): Promise<BuildFailure | undefined> {
  const file = Bun.file(join(outputDir(root), BUILD_FAILURE))

  return await file.exists() ? await file.json() as BuildFailure : undefined
}

// A compile error goes by its name, as `bootFailure` tells it: the class's module loads the compiler, which an executable leaves out.
function failureError({ message, diagnostics }: BuildFailure): Error {
  const error = Object.assign(new Error(message), diagnostics && { name: 'KayCompileError', diagnostics })

  error.stack = diagnostics ? `KayCompileError: ${message}` : message

  return error
}

// `kay dev` sends the stylesheets of a stylesheet edit to the server it does not restart for it; the open pages swap them in.
function followStyles(root: string, client: ClientBuild): ClientBuild {
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('styles' in message))
      return

    client.styles = new Map(Object.entries(message.styles as Record<string, string>).map(([file, url]) => [resolve(root, file), url]))

    for (const stream of streams) {
      try {
        stream.enqueue(`event: styles\ndata: ${Date.now()}\n\n`)
      }
      catch {
        streams.delete(stream)
      }
    }
  })
  process.send!({ followsStyles: true })

  return client
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
