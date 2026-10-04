import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { kay } from '../build/plugin'
import { loadConfig } from '../config'
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

// One bundle per component and version of its file, for the test process.
const bundles = new Map<string, Promise<MountModule>>()

// Lets queued effects and timers due now land, as after a click, before the DOM is read.
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

// Renders a component compiled for the browser, as an island renders, into the document a DOM such as happy-dom's registered: for testing what its handlers and effects do.
// `file` is the `.kay` file relative to the project, since importing it through the preload gives its server build.
export async function mount(file: string, props: Record<string, unknown> = {}): Promise<Mounted> {
  if (typeof document === 'undefined')
    throw new Error('kay: mount renders into `document`; register a DOM first, such as `GlobalRegistrator.register()` from @happy-dom/global-registrator')

  const root = testRoot()
  const path = resolve(root, file)
  const key = `${path}\0${await fileVersion(path)}`
  let bundled = bundles.get(key)

  if (!bundled)
    bundles.set(key, bundled = bundle(root, path))

  let module: MountModule

  try {
    module = await bundled
  }
  catch (error) {
    // A failed bundle is tried again on the next mount, the file fixed or not.
    bundles.delete(key)

    throw error
  }

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

// Bundled from under the project's `.kay`, where `kay/dom` resolves to the kay it installed, with its libraries' settings applied.
async function bundle(root: string, file: string): Promise<MountModule> {
  const dir = join(root, '.kay', 'test')

  await mkdir(dir, { recursive: true })

  const work = await mkdtemp(join(dir, 'mount-'))

  try {
    await Bun.write(join(work, 'entry.ts'), entry(file))

    const { settings } = await loadConfig(root)
    let output: string

    try {
      output = (await Bun.build({ entrypoints: [join(work, 'entry.ts')], outdir: join(work, 'out'), target: 'browser', plugins: [kay({ root, settings })] })).outputs[0]!.path
    }
    catch (error) {
      // Bun throws on a failed build, its messages in `errors`.
      const errors = error instanceof AggregateError ? error.errors : [error]

      throw new AggregateError(errors, `kay: bundling ${file} for the browser failed: ${errors.map(String).join('\n')}`)
    }

    return await import(output) as MountModule
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
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
