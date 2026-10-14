import type { ClientOptions } from '../build/client'
import type { KayCompileError } from '../build/transform'
import type { BuildFailure } from '../dev/builder'
import type { HotSwap } from '../runtime/client'
import type { LocaleSettings } from '../runtime/i18n'
import type { ClientBuild } from './client'
import type { ServedRoute } from './guards'
import type { MountedApi } from './openapi'
import type { Endpoint } from './routes'
import { readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Elysia } from 'elysia'
import { outputDir, underKayDev } from '../build/assets'
import { bootDevTool } from '../runtime/dev-boot'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { BUILD_FAILURE, clientOptionsKey, fromManifest, readManifest } from './client'
import { editorCommand } from './editor'
import { localeCopies } from './i18n'
import { compileErrorPage } from './overlay'
import { apiRoutePath, endpointPath, ROUTE_METHODS } from './routes'

export const DEV_EVENTS = '/_kay/dev/events'
export const DEV_PATCH = '/_kay/dev/patch.js'
export const DEV_TOOL = '/_kay/dev/tool.js'
export const DEV_INSPECTOR = '/_kay/dev/inspector.js'
export const DEV_OPEN = '/_kay/dev/open'
export const DEV_A11Y = '/_kay/dev/a11y.js'
export const DEV_AXE = '/_kay/dev/axe.js'
export const DEV_ROUTES = '/_kay/dev/routes'
const PATCH_SOURCE = resolve(import.meta.dir, '../runtime/dev-patch.ts')
const TOOL_SOURCE = resolve(import.meta.dir, '../runtime/dev-tool.ts')
const INSPECTOR_SOURCE = resolve(import.meta.dir, '../runtime/dev-inspector.ts')
const A11Y_SOURCE = resolve(import.meta.dir, '../runtime/dev-a11y.ts')
// What the inspector sends, which a page of another site cannot without a preflight nothing answers.
const OPEN_HEADER = 'x-kay-dev'
const POSITION = /^(.+\.(?:kay|[cm]?[jt]sx?)):(\d+):(\d+)$/
const BACKSLASH = /\\/g
const BRACKETS = /^\[|\]$/g
const LOCAL_NAME = /(?:^|\.)localhost$/
const TRAILING_DOT = /\.$/
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?|json|css)$/
// A path a request fills in, which the Routes tab cannot link to.
const PATH_PARAM = /[:*]/

// One per server process: `kay dev` restarts the process on every change, so a new id means new code.
const BOOT_ID = crypto.randomUUID()
// The event streams open on this server, which a stylesheet edit is pushed to.
const streams = new Set<ReadableStreamDefaultController<string>>()
// What `kay dev` said of the last restart or stylesheet swap, for the pages connecting after it.
let lastBuilt: string | undefined
let followingBuilds = false
// Once its server went away, a page connects again every 10 ms for about a restart's length, then less and less often, down to four times a second, so a server that stays down is not polled hard.
const FAST_RETRY_MS = 10
const FAST_RETRIES = 50
const SLOW_RETRY_MS = 250

// Reconnects once the restarted server is up: one running the code this page came from, restarted for a stylesheet, gets the page's stylesheets swapped in, one at a time; one running new code refreshes the page through the swap, which keeps the scroll and the islands whose props did not change, and loads the page fully when the swap cannot apply it, as after a new island. A page with no swap, as under `navigation: false`, keeps the server render it loaded with and applies what changed between it and the new one to the page, through `DEV_PATCH`; it reloads when that cannot be applied, and a server that failed to boot always reloads.
// The old links go once the new ones loaded, so the page never shows unstyled, and a page that no longer answers as it did reloads instead. A stylesheet edit swaps them the same way without a restart, on a `styles` event.
// A server restarted for edited islands only also names their new chunks: a page on the code it replaced swaps them in through `$kayHot`, keeping its state, then its stylesheets.
// The id is a meta beside the script, so the script reads the same on every server: a page swap keeps it rather than running a copy that connects again, and a policy allows it by one hash.
export const LIVE_RELOAD = `<meta name="kay-boot" content="${BOOT_ID}"><script>(()=>{let b=document.querySelector('meta[name=kay-boot]')?.content,v,s,n=0,q=Promise.resolve();const load=async()=>{try{const r=await fetch(location.href,{cache:'no-store',headers:{accept:'text/html'}});return r.ok&&!r.redirected?new DOMParser().parseFromString(await r.text(),'text/html'):null}catch{return null}},css=async(d,i)=>{const o=[...document.querySelectorAll('link[rel=stylesheet]')],u=new Set(o.map(l=>l.getAttribute('href')));await Promise.all([...d.querySelectorAll('link[rel=stylesheet]')].map(l=>new Promise(r=>{const k=document.createElement('link'),h=l.getAttribute('href');k.rel='stylesheet';k.dataset.kayDev='';k.href=u.has(h)?h+(h.includes('?')?'&':'?')+'kay-dev='+i:h;k.onload=k.onerror=r;document.head.append(k)})));for(const l of o)l.remove()},on=x=>{x.onerror=()=>{x.close();setTimeout(()=>on(new EventSource(${JSON.stringify(DEV_EVENTS)})),n++<${FAST_RETRIES}?${FAST_RETRY_MS}:Math.min(${SLOW_RETRY_MS},${FAST_RETRY_MS}*2**(n-${FAST_RETRIES})))};x.addEventListener('built',e=>{window.$kayBuilt=e.data;dispatchEvent(new CustomEvent('kay-dev-built',{detail:e.data}))});x.addEventListener('styles',e=>q=q.then(async()=>{try{const d=await load();if(!d)return location.reload();if(s)s=d;await css(d,e.data)}catch{location.reload()}}));x.addEventListener('boot',e=>(n=0,q=q.then(async()=>{let p=false;const d=e.data,s0=d.indexOf(' '),t=d.indexOf(' ',s0+1),i=d.slice(0,s0),c=t<0?d.slice(s0+1):d.slice(s0+1,t),h=t<0?null:JSON.parse(d.slice(t+1));if(i===b){v??=c;if(!window.$kayRefresh)s??=await load();return}if(c!==v){let ok=false;try{ok=!!h&&String(h.from)===v&&!!window.$kayHot&&await window.$kayHot(h)}catch{}if(!ok){if(c===i)return location.reload();if(window.$kayRefresh){try{await window.$kayRefresh()}catch{return location.reload()}}else p=true}v=c}b=i;try{const d=await load();if(!d)return location.reload();if(p){const m=await import(${JSON.stringify(DEV_PATCH)});if(!s||!m.patch(s,d))return location.reload();s=d}await css(d,i)}catch{location.reload()}})))};on(new EventSource(${JSON.stringify(DEV_EVENTS)}))})()</script>`

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
    text = new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(source, 'utf8')) + start
    devModules.set(source, text)
  }

  return new Response(text, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
}

// The module a page without the page swap applies its refresh with.
export function devPatch(): Response {
  return devModule(PATCH_SOURCE)
}

// The bar and drawer every dev page shows, which the inspector then joins under `kay dev`.
export function devTool(): Response {
  return devModule(TOOL_SOURCE, '\nwindow.$kayDev = startDevTool()\n')
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
  return LIVE_RELOAD + DEV_BOOT + devToolScripts()
}

// Opens the `.kay` or script file at the position the inspector or an error page names, in the editor `editorCommand` finds; with none, the terminal prints the position.
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

// The stream stays open until the process exits; the page connects again itself, as `LIVE_RELOAD` says.
// A server that failed to boot gives its own id as its code, so the pages on either side of it always reload.
export function devEvents(failed = false, hot?: HotSwap): Response {
  let own: ReadableStreamDefaultController<string> | undefined
  const stream = new ReadableStream<string>({
    start(controller) {
      own = controller
      streams.add(controller)
      controller.enqueue(`event: boot\ndata: ${BOOT_ID} ${failed ? BOOT_ID : process.env.KAY_DEV_CODE ?? BOOT_ID}${hot && !failed ? ` ${JSON.stringify(hot)}` : ''}\n\n`)

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

// `kay dev` sends the stylesheets of a stylesheet edit to the server it does not restart for it; the open pages swap them in.
function followStyles(root: string, client: ClientBuild): ClientBuild {
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('styles' in message))
      return

    client.styles = new Map(Object.entries(message.styles as Record<string, string>).map(([file, url]) => [resolve(root, file), url]))
    broadcast(`event: styles\ndata: ${Date.now()}\n\n`)
  })
  process.send!({ followsStyles: true })

  return client
}

// `kay dev` says what each restart and stylesheet swap rebuilt and how long it took, which the dev tool on each open page shows.
export function followBuilds(): void {
  if (process.send === undefined || followingBuilds)
    return

  followingBuilds = true
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('built' in message))
      return

    lastBuilt = `event: built\ndata: ${JSON.stringify({ id: crypto.randomUUID(), at: Date.now(), ...message.built as object })}\n\n`
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

    if (host === null || (name !== undefined && (LOCAL_NAME.test(name) || isIP(name.replace(BRACKETS, '')) !== 0 || allowed.has(name))))
      return

    return new Response(`kay dev answers to localhost, an IP address or the site, and ${host} is none of them; list it in KAY_DEV_HOSTS to reach the server by that name\n`, { status: 421, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  })
}

// What a dev server serves when the project failed to boot: the errors on every page, until a fix restarts it.
export function bootFailure(error: unknown, root: string): Elysia {
  // Told by its name: the class's module loads the compiler, which a production server never needs.
  const html = compileErrorPage(error instanceof Error && error.name === 'KayCompileError' ? (error as KayCompileError).diagnostics : [], error) + errorPageScripts()

  const app = new Elysia({ name: 'kay/pages', seed: root })

  refuseForeignHosts(app, process.env.SITE_URL)
  app.get(DEV_EVENTS, () => devEvents(true))
  app.get(DEV_TOOL, () => devTool())

  if (underKayDev()) {
    app.get(DEV_INSPECTOR, () => devInspector())
    app.post(DEV_OPEN, async ({ request }) => openInEditor(root, request))
  }

  app.get('/*', () => new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }))

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
}

// One line of the dev tool's Routes tab.
export interface DevRoute {
  kind: 'page' | 'endpoint' | 'api'
  method: string
  path: string
  // The file serving it, from the project's root.
  file: string
  locale?: string | undefined
  // Where the tab links to, for a GET path no request fills in, served on this host.
  href?: string | undefined
}

// Every page, endpoint and API route the server serves, as `kay routes` lists them, each locale's copy of a page on its own line.
export function devRoutes(root: string, pages: ServedRoute[], endpoints: Endpoint[], mounted: MountedApi[], settings: LocaleSettings | undefined, base: string): DevRoute[] {
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

  return listed
}

// The data block the dev tool reads: a script of another type never runs, so the policy has nothing to allow.
export function problemsBlock(problems: string[] | undefined): string {
  return problems && problems.length > 0 ? `<script type="application/json" id="kay-check-problems">${JSON.stringify(problems).replaceAll('<', '\\u003c')}</script>` : ''
}
