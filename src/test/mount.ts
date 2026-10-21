import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { VOUCH_MODULE } from '../build/icons'
import { kay } from '../build/plugin'
import { loadConfig } from '../config'
import { projectPaths, writesFrench } from '../project'
import { COOKIE_NAME } from '../runtime/persist'
import { sendValue } from '../runtime/send'
import { decodeValue } from '../runtime/wire'
import { apiStubs, apiTrees } from '../server/api-modules'
import { testRoot } from './root'

export interface Mounted {
  // The element the component rendered into, last in `document.body`.
  root: HTMLElement
  // Disposes of the component, running its cleanups once, and removes the element.
  unmount: () => void
}

interface MountModule {
  mount: (element: HTMLElement, props: Record<string, unknown>) => () => void
}

const SAFE_HTML_MODULE = /(?:^|[/\\])safe-html(?:\.ts)?$/
// One bundle per component and version of its file, for the test process, evaluated again on every mount.
const bundles = new Map<string, Promise<string>>()

// Lets queued effects and timers due now land, as after a click, before the DOM is read.
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

// Keeps a value in localStorage as `persisted(key, initial, { storage: 'local' })` does, encoded as island props are rather than as JSON, for a component mounted after to read.
export function writePersisted(key: string, value: unknown): void {
  localStorage.setItem(key, sendValue(value))
}

// A `Cookie` header value setting the cookie a `persisted(name, initial)` signal keeps its value in, for `site.as(persistedCookie('scheme', 'light'))`: the first render of a page reads it.
export function persistedCookie(name: string, value: unknown): string {
  if (!COOKIE_NAME.test(name))
    throw new TypeError(`kay: ${JSON.stringify(name)} cannot name a cookie; give persistedCookie() a name of letters, digits and - _ .`)

  return `${name}=${encodeURIComponent(sendValue(value))}`
}

// The value a `persisted(key, initial, { storage: 'local' })` signal kept in localStorage, decoded, or undefined when it kept none.
export function readPersisted(key: string): unknown {
  const text = localStorage.getItem(key)

  return text === null ? undefined : decodeValue(text)
}

// Registers happy-dom's DOM on the first mount of a file, so a file that mounts nothing never loads it; a project that preloaded `kay/test/dom` already has one.
async function registerDom(): Promise<void> {
  try {
    await import('./dom')
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('@happy-dom/global-registrator'))
      throw new Error('kay: mountComponent renders into a DOM that happy-dom provides: add it with `bun add -d @happy-dom/global-registrator`', { cause: error })

    throw error
  }
}

// Renders a component compiled for the browser, as an island renders, into the document a DOM such as happy-dom's registered: for testing what its handlers and effects do.
// `file` is the `.kay` file relative to the project, since importing it through the preload gives its server build.
export async function mountComponent(file: string, props: Record<string, unknown> = {}): Promise<Mounted> {
  if (typeof document === 'undefined')
    await registerDom()

  const root = testRoot()
  const path = resolve(root, file)
  const key = `${path}\0${await fileVersion(path)}`
  let bundled = bundles.get(key)

  if (!bundled)
    bundles.set(key, bundled = bundle(root, path))

  let code: string

  try {
    code = await bundled
  }
  catch (error) {
    // A failed bundle is tried again on the next mount, the file fixed or not.
    bundles.delete(key)

    throw error
  }

  const module = await evaluate(root, code)
  const element = document.createElement('div')

  document.body.append(element)

  const dispose = module.mount(element, props)
  let mounted = true

  await settle()

  return { root: element, unmount: () => {
    if (!mounted)
      return

    mounted = false
    dispose()
    element.remove()
  } }
}

// The bundle shares what the test process vouched for, such as an icon the test builds, as an island shares it with the page; its own copy would vouch for nothing.
const sharedMarks: Bun.BunPlugin = {
  name: 'kay-shared-marks',
  setup(build) {
    build.onResolve({ filter: SAFE_HTML_MODULE }, (args) => {
      // Only kay's own module, by its resolved path: another `safe-html` keeps its own.
      try {
        if (Bun.resolveSync(args.path, args.importer ? dirname(args.importer) : process.cwd()) !== VOUCH_MODULE)
          return undefined
      }
      catch {
        return undefined
      }

      return { path: VOUCH_MODULE, external: true }
    })
  },
}

// Bundled from under the project's `.kay`, where `kay/dom` resolves to the kay it installed, with its libraries' settings applied and the French spaces of an island on a French site, the other client defines left out.
async function bundle(root: string, file: string): Promise<string> {
  const work = await mkdtemp(join(await testDir(root), 'mount-'))

  try {
    await Bun.write(join(work, 'entry.ts'), entry(file))

    const config = await loadConfig(root)
    const trees = apiTrees(root, config)
    let output: Bun.BuildArtifact

    try {
      output = (await Bun.build({ entrypoints: [join(work, 'entry.ts')], outdir: join(work, 'out'), target: 'browser', define: { KAY_FRENCH: writesFrench(config) ? 'true' : 'undefined' }, plugins: [apiStubs(trees), kay({ root, settings: config.settings, api: trees }), sharedMarks] })).outputs[0]!
    }
    catch (error) {
      // Bun throws on a failed build, its messages in `errors`.
      const errors = error instanceof AggregateError ? error.errors : [error]

      throw new AggregateError(errors, `kay: bundling ${file} for the browser failed: ${errors.map(String).join('\n')}`)
    }

    return await output.text()
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

// The bundle's modules run afresh, as on a page load, so what one mount left in them, such as a persisted signal read from storage, does not reach the next.
async function evaluate(root: string, code: string): Promise<MountModule> {
  const file = join(await testDir(root), `mount-${crypto.randomUUID()}.js`)

  await Bun.write(file, code)

  try {
    return await import(file) as MountModule
  }
  finally {
    await rm(file, { force: true })
  }
}

async function testDir(root: string): Promise<string> {
  const dir = projectPaths(root).tests

  await mkdir(dir, { recursive: true })

  return dir
}

// Changes when the file is rewritten, so a test editing a component between mounts gets its new build.
async function fileVersion(path: string): Promise<string> {
  try {
    const { mtimeMs, size } = await stat(path)

    return `${mtimeMs}:${size}`
  }
  catch {
    return 'missing'
  }
}

function entry(file: string): string {
  return `import { render } from 'kay/dom'
import Component from ${JSON.stringify(file)}

export function mount(element, props) {
  return render(() => Component(props), element)
}
`
}
