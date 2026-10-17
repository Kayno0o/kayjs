import type { ClientOptions } from '../build/client'
import type { KayCompileError } from '../build/transform'
import type { KayExtension } from '../config'
import type { BuildFailure } from '../dev/builder'
import type { HotSwap } from '../runtime/client'
import type { LocaleSettings } from '../runtime/i18n'
import type { ClientBuild } from './client'
import type { ServedRoute } from './guards'
import type { MountedApi } from './openapi'
import type { Endpoint } from './routes'
import type { Claim } from './served-paths'
import { readFileSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Elysia } from 'elysia'
import { outputDir, underKayDev } from '../build/assets'
import { siteFromEnv } from '../config'
import { bootDevTool } from '../runtime/dev-boot'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { routerPath } from './base'
import { nodeNet } from './builtins'
import { BUILD_FAILURE, clientOptionsKey, fromManifest, readManifest } from './client'
import { redirectedBy } from './dev-notes'
import { editorCommand } from './editor'
import { localeCopies } from './i18n'
import { compileErrorPage } from './overlay'
import { requestId } from './protection'
import { apiRoutePath, endpointPath, ROUTE_METHODS } from './routes'

export const DEV_EVENTS = '/_kay/dev/events'
export const DEV_PATCH = '/_kay/dev/patch.js'
export const DEV_TOOL = '/_kay/dev/tool.js'
const DEV_EXTENSION = '/_kay/dev/extension/'

export const DEV_INSPECTOR = '/_kay/dev/inspector.js'
export const DEV_OPEN = '/_kay/dev/open'
export const DEV_A11Y = '/_kay/dev/a11y.js'
export const DEV_AXE = '/_kay/dev/axe.js'
export const DEV_ROUTES = '/_kay/dev/routes'
export const DEV_HEAD = '/_kay/dev/head'
export const DEV_REQUEST = '/_kay/dev/request'
export const DEV_SIZES = '/_kay/dev/sizes'
export const DEV_NOT_FOUND = '/_kay/dev/not-found'

// Reloads a page kay does not render, such as a library's own, once `kay dev` restarts the server for a changed file: its stream names the server it comes from first.
export const RESTART_RELOAD = `let b;new EventSource(${JSON.stringify(DEV_EVENTS)}).addEventListener('boot',e=>{const i=e.data.split(' ')[0];if(b&&i!==b)location.reload();b=i})`
const PATCH_SOURCE = resolve(import.meta.dir, '../runtime/dev-patch.ts')
const TOOL_SOURCE = resolve(import.meta.dir, '../runtime/dev-tool.ts')
const INSPECTOR_SOURCE = resolve(import.meta.dir, '../runtime/dev-inspector.ts')
const A11Y_SOURCE = resolve(import.meta.dir, '../runtime/dev-a11y.ts')
// What the inspector sends, which a page of another site cannot without a preflight nothing answers.
const OPEN_HEADER = 'x-kay-dev'
const LIVE_RELOAD_HEADER = 'x-kay-live-reload'
// The entry the live reload's fetches are answered with, copied in dev-tool.ts.
const LIVE_RELOAD_TIMING = 'kay-live-reload'
const POSITION = /^(.+\.(?:kay|[cm]?[jt]sx?|css)):(\d+):(\d+)$/
const BACKSLASH = /\\/g
const BRACKETS = /^\[|\]$/g
const LOCAL_NAME = /(?:^|\.)localhost$/
const TRAILING_DOT = /\.$/
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?|json|css)$/
// A path a request fills in, which the Routes tab cannot link to.
const PATH_PARAM = /[:*]/

// One per server run: `kay dev` starts a process or reloads the running one on every change, so a new id means new code.
let bootId = crypto.randomUUID()
// What the latest run told the pages that connect: whether it failed to boot and the page swap its build allows.
let latestBoot: { failed: boolean, hot?: HotSwap | undefined } = { failed: false }
// The event streams open on this server, which a stylesheet edit is pushed to.
const streams = new Set<ReadableStreamDefaultController<string>>()
// What `kay dev` said of the last restart or stylesheet swap, for the pages connecting after it.
let lastBuilt: string | undefined
let followingBuilds = false
// Once its server went away, a page connects again every 10 ms for about a restart's length, then less and less often, down to four times a second, so a server that stays down is not polled hard.
const FAST_RETRY_MS = 10
const FAST_RETRIES = 50
const SLOW_RETRY_MS = 250
// A fetch of the page that cannot connect, as a server announcing itself may not yet be answering under load, is tried again this many times, this far apart, before the page reloads.
const LOAD_RETRIES = 20
const LOAD_RETRY_MS = 100

// Reconnects once the restarted server is up: one running the code this page came from, restarted for a stylesheet, gets the page's stylesheets swapped in, one at a time; one running new code refreshes the page through the swap, which keeps the scroll and the islands whose props did not change, and loads the page fully when the swap cannot apply it, as after a new island. A page with no swap, as under `navigation: false`, keeps the server render it loaded with and applies what changed between it and the new one to the page, through `DEV_PATCH`; it reloads when that cannot be applied, and a server that failed to boot always reloads.
// The old links go once the new ones loaded, so the page never shows unstyled, and a page that no longer answers as it did reloads instead. A stylesheet edit swaps them the same way without a restart, on a `styles` event.
// A server restarted for edited islands only also names their new chunks: a page on the code it replaced swaps them in through `$kayHot`, keeping its state, then its stylesheets.
// Each page fetch it makes carries `x-kay-live-reload`, which `recordResponses` answers with a `Server-Timing` entry for the dev tool's Network tab to leave out.
// The id is a meta beside the script, so the script reads the same on every server: a page swap keeps it rather than running a copy that connects again, and a policy allows it by one hash.
// The reloads the script notes for the dev tool to tell its fetches by: a fetch's timing name drops the `#fragment`, and only the last few can still be matched.
const RELOAD_NOTES = 20
const LIVE_RELOAD_SCRIPT = `<script>(()=>{let b=document.querySelector('meta[name=kay-boot]')?.content,v,s,n=0,q=Promise.resolve();const load=async(k=0)=>{try{const a=window.$kayReloads??=[];a.push([location.href.split('#')[0],performance.now()]);if(a.length>${RELOAD_NOTES})a.shift();const r=await fetch(location.href,{cache:'no-store',headers:{'accept':'text/html','x-kay-live-reload':'1'}});return r.ok&&!r.redirected?new DOMParser().parseFromString(await r.text(),'text/html'):null}catch{return k===${LOAD_RETRIES}?null:(await new Promise(r=>setTimeout(r,${LOAD_RETRY_MS})),load(k+1))}},css=async(d,i)=>{const o=[...document.querySelectorAll('link[rel=stylesheet]')],u=new Set(o.map(l=>l.getAttribute('href')));await Promise.all([...d.querySelectorAll('link[rel=stylesheet]')].map(l=>new Promise(r=>{const k=document.createElement('link'),h=l.getAttribute('href');k.rel='stylesheet';k.dataset.kayDev='';k.href=u.has(h)?h+(h.includes('?')?'&':'?')+'kay-dev='+i:h;k.onload=k.onerror=r;document.head.append(k)})));for(const l of o)l.remove()},on=x=>{x.onerror=()=>{x.close();setTimeout(()=>on(new EventSource(${JSON.stringify(DEV_EVENTS)})),n++<${FAST_RETRIES}?${FAST_RETRY_MS}:Math.min(${SLOW_RETRY_MS},${FAST_RETRY_MS}*2**(n-${FAST_RETRIES})))};x.addEventListener('built',e=>{dispatchEvent(new CustomEvent('kay-dev-built',{detail:e.data}))});x.addEventListener('styles',e=>q=q.then(async()=>{try{const d=await load();if(!d)return location.reload();if(s)s=d;await css(d,e.data)}catch{location.reload()}}));x.addEventListener('boot',e=>(n=0,q=q.then(async()=>{let p=false;const d=e.data,s0=d.indexOf(' '),t=d.indexOf(' ',s0+1),i=d.slice(0,s0),c=t<0?d.slice(s0+1):d.slice(s0+1,t),h=t<0?null:JSON.parse(d.slice(t+1));if(i===b){v??=c;if(!window.$kayRefresh)s??=await load();return}if(c!==v){let ok=false;try{ok=!!h&&String(h.from)===v&&!!window.$kayHot&&await window.$kayHot(h)}catch{}if(!ok){if(c===i)return location.reload();if(window.$kayRefresh){try{await window.$kayRefresh()}catch{return location.reload()}}else p=true}v=c}b=i;try{const d=await load();if(!d)return location.reload();if(p){const m=await import(${JSON.stringify(DEV_PATCH)});if(!s||!m.patch(s,d))return location.reload();s=d}await css(d,i)}catch{location.reload()}})))};on(new EventSource(${JSON.stringify(DEV_EVENTS)}))})()</script>`

export function liveReload(): string {
  return `<meta name="kay-boot" content="${bootId}">${LIVE_RELOAD_SCRIPT}`
}

// Keeps each problem kay logs before the dev tool loads, which then lists them; the page carries the function itself, so a policy allows it by one hash.
export const DEV_BOOT = `<script>(${bootDevTool.toString()})(window)</script>`

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

// The browser modules of the dev tools, each its TypeScript source stripped to what a browser runs, then what starts it.
const devModules = new Map<string, string>()

function devModule(source: string, start = ''): Response {
  let text = devModules.get(source)

  if (text === undefined) {
    text = new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(source, 'utf8'))
    devModules.set(source, text)
  }

  return new Response(text + start, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
}

// The module a page without the page swap applies its refresh with.
export function devPatch(): Response {
  return devModule(PATCH_SOURCE)
}

// The bar and drawer every dev page shows, which the inspector then joins under `kay dev`.
export function devTool(modules: DevToolFile[] = []): Response {
  const loading = modules.length === 0 ? '' : `if (window.$kayDev) loadDevModules(window.$kayDev, ${JSON.stringify(modules.map(({ name, url }) => ({ name, url })))})\n`

  return devModule(TOOL_SOURCE, `\nwindow.$kayDev = startDevTool()\n${loading}`)
}

// A browser module an extension names in `devTool`, the file it is read from and the path it is served at.
export interface DevToolFile {
  name: string
  url: string
  file: string
}

// The modules the extensions name, each file once, served from `/_kay/dev/extension/<n>.js` in the order the extensions come.
export function devToolFiles(root: string, extensions: KayExtension[] | undefined): DevToolFile[] {
  const files = new Map<string, DevToolFile>()

  for (const { name, devTool: tool } of extensions ?? []) {
    const file = tool === undefined ? undefined : resolve(root, tool.module)

    if (file !== undefined && !files.has(file))
      files.set(file, { name, url: `${DEV_EXTENSION}${files.size}.js`, file })
  }

  return [...files.values()]
}

// The browser module of one extension, read again on each request: it is the library's file, not kay's, and a dev server holds no cache of it.
export async function devToolFile(file: string): Promise<Response> {
  try {
    const text = new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(file).text())

    return new Response(text, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
  }
  catch (error) {
    kayLog('error', `kay: the dev tool module ${file} could not be served: ${error instanceof Error ? error.message : String(error)}`)

    return new Response(null, { status: 404 })
  }
}

// Joins the dev tool, unless it failed to start, whose error the console already shows.
export function devInspector(): Response {
  return devModule(INSPECTOR_SOURCE, '\nif (window.$kayDev) startInspector(window.$kayDev)\n')
}

// Checks each page the dev server serves with axe-core once it settles, its violations showing in the dev tool's problems.
export const A11Y_SCRIPT = `<script type="module" src="${DEV_A11Y}"></script>`

export function devA11y(): Response {
  return devModule(A11Y_SOURCE, '\nstartA11y()\n')
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

// Loads the dev tool on every dev page, and the inspector into it on the pages of a server `kay dev` started, the one whose elements carry their source position.
export function devToolScripts(): string {
  return `<script type="module" src="${DEV_TOOL}"></script>${underKayDev() ? `<script type="module" src="${DEV_INSPECTOR}"></script>` : ''}`
}

// Loads the dev tool on kay's error pages, whose buttons it answers: the copy button, and under `kay dev` each source position.
export function errorPageScripts(): string {
  return liveReload() + DEV_BOOT + devToolScripts()
}

// Opens the `.kay`, script or stylesheet at the position the inspector or an error page names, in the editor `editorCommand` finds; with none, the terminal prints the position.
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

// The code version pages are told of: the environment's as the run began, kept until the reload announces so a page served by the run before is not told it runs the new code.
let announcedCode: string | undefined

function bootEvent(failed: boolean, hot?: HotSwap): string {
  announcedCode ??= process.env.KAY_DEV_CODE

  return `event: boot\ndata: ${bootId} ${failed ? bootId : announcedCode ?? bootId}${hot && !failed ? ` ${JSON.stringify(hot)}` : ''}\n\n`
}

// A run of the server, which a reload follows in the same process: the pages it serves are the ones to tell once it has taken over.
export function rememberBoot(failed: boolean, hot?: HotSwap): void {
  latestBoot = { failed, hot }
}

// Tells every page connected that the server runs new code, as a new process would by the pages connecting again.
export function announceReload(): void {
  bootId = crypto.randomUUID()
  announcedCode = process.env.KAY_DEV_CODE
  broadcast(bootEvent(latestBoot.failed, latestBoot.hot))
}

// The stream stays open until the process exits or reloads; the page connects again itself, as `LIVE_RELOAD` says.
// A server that failed to boot gives its own id as its code, so the pages on either side of it always reload.
export function devEvents(failed = false, hot?: HotSwap): Response {
  let own: ReadableStreamDefaultController<string> | undefined
  const stream = new ReadableStream<string>({
    start(controller) {
      own = controller
      streams.add(controller)
      controller.enqueue(bootEvent(failed, hot))

      if (lastBuilt !== undefined)
        controller.enqueue(lastBuilt)
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

// The build whose stylesheets `kay dev` sends on: the latest run's, as a reload in this process makes a new one.
let followed: { root: string, client: ClientBuild } | undefined

// `kay dev` sends the stylesheets of a stylesheet edit to the server it does not restart for it; the open pages swap them in.
function followStyles(root: string, client: ClientBuild): ClientBuild {
  const first = followed === undefined

  followed = { root, client }

  if (first) {
    process.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('styles' in message) || followed === undefined)
        return

      followed.client.styles = new Map(Object.entries(message.styles as Record<string, string>).map(([file, url]) => [resolve(followed!.root, file), url]))
      broadcast(`event: styles\ndata: ${Date.now()}\n\n`)
    })
  }

  process.send!({ followsStyles: true })

  return client
}

// The Elysia apps that listen, which `kay dev` stops when it reloads the server in this process, so the hooks they started with (jobs, queues) end with them.
const running = new Set<Pick<Elysia, 'stop'>>()

export function trackRunning(app: Pick<Elysia, 'stop'>): void {
  running.add(app)
}

// Runs the `onStop` hooks of the apps that listened; their servers keep listening, as the reload hands them to the apps that follow.
export async function stopRunning(): Promise<void> {
  for (const app of running) {
    running.delete(app)

    try {
      await app.stop()
    }
    catch (error) {
      console.error(error)
    }
  }
}

// `kay dev` says each restart and stylesheet swap it made, which the dev tool on each open page hears to read what it shows again.
export function followBuilds(): void {
  if (process.send === undefined || followingBuilds)
    return

  followingBuilds = true
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('built' in message))
      return

    lastBuilt = `event: built\ndata: ${JSON.stringify(message.built)}\n\n`
    broadcast(lastBuilt)
  })
}

function broadcast(event: string): void {
  for (const stream of streams) {
    try {
      stream.enqueue(event)
    }
    catch {
      streams.delete(stream)
    }
  }
}

// Under `kay dev`, a request naming a host other than localhost, an IP address or the site is refused, as a page of another site renaming itself to this machine's address (DNS rebinding) would send it.
// `KAY_DEV_HOSTS` lists other names the server answers to, comma-separated, such as a tunnel's; `kay dev --host` adds this machine's own names, as a phone on the network reaches it by.
export function refuseForeignHosts(app: Elysia, site: string | undefined): void {
  if (!underKayDev())
    return

  const allowed = new Set((process.env.KAY_DEV_HOSTS ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean))
  const siteName = site === undefined ? undefined : URL.parse(site)?.hostname
  const listening = process.env.KAY_DEV_HOST ?? 'localhost'

  if (siteName !== undefined)
    allowed.add(siteName)

  if (listening !== 'localhost')
    allowed.add(listening.toLowerCase()).add(hostname().toLowerCase()).add(`${hostname().toLowerCase()}.local`)

  app.onRequest(({ request }) => {
    const host = request.headers.get('host')
    const name = host === null ? undefined : URL.parse(`http://${host}`)?.hostname.replace(TRAILING_DOT, '')

    if (host === null || (name !== undefined && (LOCAL_NAME.test(name) || nodeNet().isIP(name.replace(BRACKETS, '')) !== 0 || allowed.has(name))))
      return

    return new Response(`kay dev answers to localhost, an IP address or the site, and ${host} is none of them; list it in KAY_DEV_HOSTS to reach the server by that name\n`, { status: 421, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  })
}

// What a dev server serves when the project failed to boot: the errors on every page, until a fix restarts it.
export function bootFailure(error: unknown, root: string): Elysia {
  // Told by its name: the class's module loads the compiler, which a production server never needs.
  const built = bootId
  const html = compileErrorPage(error instanceof Error && error.name === 'KayCompileError' ? (error as KayCompileError).diagnostics : [], error) + errorPageScripts()

  const app = new Elysia({ name: 'kay/pages', seed: root })

  rememberBoot(true)
  refuseForeignHosts(app, siteFromEnv())
  app.get(DEV_EVENTS, () => devEvents(true))
  app.get(DEV_TOOL, () => devTool())

  if (underKayDev()) {
    app.get(DEV_INSPECTOR, () => devInspector())
    app.post(DEV_OPEN, async ({ request }) => openInEditor(root, request))
  }

  app.get('/*', () => new Response(html.replaceAll(built, bootId), { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }))

  return app
}

// What the dev tool's Request tab shows, as a dev page carries it.
export interface DevRequest {
  route?: string | undefined
  page: string
  layouts: string[]
  params: Record<string, unknown>
  locale: string
  status: number
  error?: string | undefined
  loads: { file: string, ms?: number | undefined }[]
  // The id the server recorded the response under, which `DEV_REQUEST` answers with the headers, the time and the redirects.
  id: string
  // Every guard of the route in the order they run, with what each did; the ones after a refusal did not run.
  guards: { file: string, outcome: string }[]
  // What `kay build` does with the page: written ahead (`page`), for the paths its setting lists (`listed`), or because it holds a server island; none when it is rendered on request only.
  prerender?: 'page' | 'listed' | 'server islands' | undefined
  // The page in each locale of a site with `i18n` that serves more than one, where a language switcher links to: the locale and the address, under the base.
  locales?: { locale: string, href: string }[] | undefined
}

// What the server recorded of one response, for the Request tab to ask for once the page is in view.
export interface DevResponse {
  headers: [name: string, value: string][]
  // From the request reaching the server to its response being made, the loads, guards and render included; a streamed page's body goes on after.
  ms: number
  // The redirects the request went through before this one, the first first.
  redirects: { from: string, status: number, by?: string | undefined }[]
}

const RECORDED_RESPONSES = 50
const REDIRECT_MEMORY_MS = 30_000
const FRAMEWORK_PATH = /^\/_kay\//

// A cookie's name and attributes stay, its value does not: it is a session's secret and the tab can be on a shared screen.
const COOKIE_VALUE = /^([^=;]*)=[^;]*/

function maskedValue(name: string, value: string): string {
  return name === 'set-cookie' ? value.replace(COOKIE_VALUE, '$1=...') : value
}

// Records what each page a dev server answers carried, and the redirect hops leading to a path, so the Request tab can say how a page was answered and sent.
// A hop is handed to the next page request for its target from the same user agent within a short while, so a second tab on the same browser can take it; kay cannot tell a followed redirect from a request that merely comes next.
// Registered after the hooks that shape a response, so the headers are the ones sent; a request answered before the routes, or by a hook that stops the others, is not recorded.
export function recordResponses(app: Elysia, base = ''): void {
  const started = new WeakMap<Request, number>()
  const recorded = new Map<string, DevResponse>()
  const hops = new Map<string, { redirects: DevResponse['redirects'], at: number }>()

  app.onRequest(({ request }) => {
    started.set(request, performance.now())
  })

  app.mapResponse({ as: 'global' }, ({ request, responseValue, set }) => {
    const url = new URL(request.url)

    if (FRAMEWORK_PATH.test(url.pathname))
      return

    const response = responseValue instanceof Response ? responseValue : undefined

    // Resource Timing hides request headers but shows this entry, which the live reload's fetches get next to the page's own phases and the dev tool's Network tab reads.
    if (request.headers.has(LIVE_RELOAD_HEADER)) {
      const phases = set.headers['server-timing']

      set.headers['server-timing'] = phases !== undefined && phases !== '' ? `${phases}, ${LIVE_RELOAD_TIMING}` : LIVE_RELOAD_TIMING

      try {
        response?.headers.append('server-timing', LIVE_RELOAD_TIMING)
      }
      catch {
        // A response with immutable headers, as a redirect built by `Response.redirect`, carries the entry from `set.headers`.
      }
    }

    const headers = new Headers(response?.headers)

    for (const [name, value] of Object.entries(set.headers)) {
      if (!headers.has(name) && value !== undefined)
        headers.set(name, String(value))
    }

    const status = response?.status ?? (typeof set.status === 'number' ? set.status : 200)
    const agent = request.headers.get('user-agent') ?? ''
    const here = `${url.pathname}${url.search}`
    const location = status >= 300 && status < 400 ? headers.get('location') : null
    const target = location === null ? undefined : URL.parse(location, request.url)
    const remembered = hops.get(`${agent} ${here}`)
    const redirects = remembered && Date.now() - remembered.at < REDIRECT_MEMORY_MS ? remembered.redirects : []

    hops.delete(`${agent} ${here}`)

    // The location is under `base` as the browser sends it, the next request is not.
    if (target?.origin === url.origin) {
      hops.set(`${agent} ${routerPath(target.pathname, base)}${target.search}`, { redirects: [...redirects, { from: here, status, by: redirectedBy(request) }], at: Date.now() })

      if (hops.size > RECORDED_RESPONSES)
        hops.delete(hops.keys().next().value!)
    }

    // The pages are what the tab asks about; the assets around them would push them out.
    if (!headers.get('content-type')?.startsWith('text/html'))
      return

    recorded.set(requestId(request), { headers: [...headers.entries()].map(([name, value]) => [name, maskedValue(name, value)]), ms: performance.now() - (started.get(request) ?? performance.now()), redirects })

    if (recorded.size > RECORDED_RESPONSES)
      recorded.delete(recorded.keys().next().value!)
  })

  app.get(DEV_REQUEST, ({ request }) => {
    if (request.headers.get(OPEN_HEADER) === null || isCrossSite(request))
      return new Response(null, { status: 403 })

    const found = recorded.get(new URL(request.url).searchParams.get('id') ?? '')

    return found ? Response.json(found) : new Response(null, { status: 404 })
  })
}

// What the dev tool's Head tab asks of the server about the page in view: what `kay check` would flag in its head, and whether the sitemap lists it.
export interface DevHead {
  // What a search result shows of a description before cutting it.
  descriptionLength: number
  // The origin the site is public at, none when `site`, `SITE_URL` and `ORIGIN` are unset.
  site?: string | undefined
  // `none` when there is no origin and so no sitemap, `error` when building it failed, `sitemapError` saying why.
  sitemap: 'listed' | 'unlisted' | 'none' | 'error'
  sitemapError?: string | undefined
  problems: { code?: string | undefined, severity: string, message: string, note?: string | undefined, help?: string | undefined }[]
}

// One line of the dev tool's Routes tab.
export interface DevRoute {
  kind: 'page' | 'endpoint' | 'api' | 'kay'
  method: string
  path: string
  // The file serving it, from the project's root; empty for what kay or a library serves.
  file: string
  // What serves a `kay` path: the sitemap, a collection's feed, the extension mounting it.
  owner?: string | undefined
  locale?: string | undefined
  // Where the tab links to, for a GET path no request fills in, served on this host.
  href?: string | undefined
}

// What the Routes tab reads: the routes, and why something it would expect is missing.
export interface DevRoutes {
  routes: DevRoute[]
  notes: string[]
}

// What serves itself besides the app's files: the claims of kind `kay` the server still holds, the GET routes the extensions mounted, and what to tell of what is missing.
export interface OwnRoutes {
  claims: Claim[]
  extensions: { owner: string, path: string }[]
  notes: string[]
}

// Every page, endpoint and API route the server serves, as `kay routes` lists them, each locale's copy of a page on its own line, then what kay and the extensions serve themselves.
export function devRoutes(root: string, pages: ServedRoute[], endpoints: Endpoint[], mounted: MountedApi[], settings: LocaleSettings | undefined, base: string, own: OwnRoutes): DevRoutes {
  const shown = (file: string) => relative(root, file).replace(BACKSLASH, '/')
  const href = (path: string, host?: string) => host === undefined && !PATH_PARAM.test(path) ? base + path : undefined
  const listed: DevRoute[] = []

  for (const page of pages) {
    for (const copy of localeCopies(settings, page.pattern))
      listed.push({ kind: 'page', method: 'GET', path: copy.path, file: shown(page.file), locale: copy.locale, href: href(copy.path, copy.host) })
  }

  for (const endpoint of endpoints) {
    const path = endpointPath(endpoint)

    listed.push({ kind: 'endpoint', method: 'GET', path, file: shown(endpoint.file), href: href(path) })
  }

  for (const module of mounted) {
    for (const route of module.instance.routes.filter(route => ROUTE_METHODS.test(route.method))) {
      const path = apiRoutePath(module.mount, route.path)

      listed.push({ kind: 'api', method: route.method.toUpperCase(), path, file: shown(module.file), href: route.method.toUpperCase() === 'GET' ? href(path) : undefined })
    }
  }

  const seen = new Set<string>()
  const itself = [
    ...own.claims.map(claim => ({ method: claim.method ?? 'GET', path: claim.path, owner: claim.owner })),
    ...own.extensions.map(({ owner, path }) => ({ method: 'GET', path, owner: `the extension ${owner}` })),
  ]

  for (const { method, path, owner } of itself) {
    // A scoped claim, a locale's copy of a feed, names the same path.
    if (!seen.has(`${method} ${path}`)) {
      seen.add(`${method} ${path}`)
      listed.push({ kind: 'kay', method: method.toUpperCase(), path, file: '', owner, href: method.toUpperCase() === 'GET' ? href(path) : undefined })
    }
  }

  return { routes: listed, notes: own.notes }
}

// The data block the dev tool reads: a script of another type never runs, so the policy has nothing to allow.
export function problemsBlock(problems: string[] | undefined): string {
  return problems && problems.length > 0 ? `<script type="application/json" id="kay-check-problems">${JSON.stringify(problems).replaceAll('<', '\\u003c')}</script>` : ''
}
