// The build step that gives a tool action's `outputSchema` to the server: the handler's return type, read through tsgo's declaration emit (output-schema.ts), recorded in the output folder under the action's file and name.
import type { CheckOptions } from '.'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, parse, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { KAY_DIR } from '../build/assets'
import { nativeExe } from '../compiler/native-typescript'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { noteMissingPeer } from '../peers'
import { projectPaths } from '../project'
import { routeMounts, scanRoutes } from '../server/routes'
import { TOOL_OUTPUTS_RECORD, toolOutputKey } from '../server/tool-outputs'
import { outputSchemasOf, WIRE_PRELUDE } from './output-schema'
import { writeShadowTypes } from './shadow-types'
import { typingStamp } from './typing-stamp'

// A run that does not end by then is stopped, and the tools list none: the build goes on.
const EMIT_TIMEOUT = 2 * 60_000
const PROBE_DIR = 'tool-probe'
// Under `.kay/cache`, which `kay build --no-cache` empties: the declarations of the last emit, with the stamp of the files they were read from.
const DECLARATIONS_CACHE = 'tool-declarations.json'

const running = new Map<string, Promise<void>>()

interface Probe {
  key: string
  file: string
  name: string
}

// The tool actions the routes' pages, layouts and action modules export that declare no `output`.
async function probesOf(root: string, options: CheckOptions): Promise<Probe[]> {
  const routes = await scanRoutes(projectPaths(root, options).routes, routeMounts(root, options.extensions))
  const files = new Set(routes.flatMap(route => [route.file, ...route.layouts, ...route.actionModules ?? []]))
  const probes: Probe[] = []

  for (const file of files) {
    const source = await Bun.file(file).text()

    for (const { name, output } of analyzeServer(source, parseKay(source).server)?.toolActions ?? []) {
      if (!output)
        probes.push({ key: toolOutputKey(root, file, name), file, name })
    }
  }

  return probes
}

// Records the schema of each tool action of the project at `root` that declares no `output`, in `output`; no record where none can be told, and no tsgo run where no action asks for one.
// The tsconfig is the project's own, so the handlers type as `kay check` types them; a type error elsewhere does not stop the emit. `shadowed` says the shadow tree is current.
// Resolves whatever happens: a missing checker or a failed run leaves the actions with no derived schema.
export async function deriveToolOutputs(root: string, options: CheckOptions, output: string, run: { tsconfig?: string | undefined, shadowed?: boolean } = {}): Promise<void> {
  // One at a time per project, as they share the probe's folder.
  const before = running.get(root) ?? Promise.resolve()
  const turn = (async () => {
    await before
    await writeRecord(root, options, output, run)
  })()

  running.set(root, turn)
  await turn
}

async function writeRecord(root: string, options: CheckOptions, output: string, { tsconfig = 'tsconfig.json', shadowed = false }: { tsconfig?: string | undefined, shadowed?: boolean }): Promise<void> {
  const record = join(output, TOOL_OUTPUTS_RECORD)

  try {
    const probes = await probesOf(root, options)
    const outputs = probes.length === 0 ? {} : await emitted(root, options, probes, tsconfig, shadowed)

    // A run that gave nothing to read says nothing of the types.
    if (outputs === undefined)
      return

    if (Object.keys(outputs).length === 0) {
      await rm(record, { force: true })

      return
    }

    const text = JSON.stringify({ outputs })

    // Written aside and moved in place, so a server reading it meanwhile never meets half of it.
    if (!existsSync(record) || await Bun.file(record).text() !== text) {
      const aside = `${record}.${process.pid}`

      try {
        await Bun.write(aside, text)
        await rename(aside, record)
      }
      finally {
        await rm(aside, { force: true })
      }
    }
  }
  catch (error) {
    // The last record stays: a run that failed says nothing of the types, and a server listing the schemas should not lose them to one.
    noteMissingPeer(error, 'the output schemas of the tool actions')
  }
}

async function emitted(root: string, options: CheckOptions, probes: Probe[], tsconfig: string, shadowed: boolean): Promise<Record<string, Record<string, unknown>> | undefined> {
  if (!shadowed)
    await writeShadowTypes(root, { ...options, typesOnly: true })

  const stamp = async () => typingStamp(root, resolve(root, tsconfig), [WIRE_PRELUDE, ...probes.map(({ key }) => key)])
  const before = await stamp()
  const kept = await keptDeclarations(root, before)
  const declarations = kept ?? await emitDeclarations(root, probes, tsconfig)

  // A run that gave nothing to read says nothing of the types.
  if (declarations === undefined)
    return undefined

  if (kept === undefined) {
    // A file or the shadow tree written while it ran may have been read in half: nothing is kept, and the next run emits again.
    if (await stamp() !== before)
      return undefined

    await keepDeclarations(root, before, declarations)
  }

  const schemas = outputSchemasOf(declarations)
  const outputs: Record<string, Record<string, unknown>> = {}

  for (const [at, { key }] of probes.entries()) {
    const schema = schemas.get(`t${at}`)

    if (schema !== undefined)
      outputs[key] = schema
  }

  return outputs
}

// The declarations tsgo emitted for the probes, which the schemas are read from.
async function emitDeclarations(root: string, probes: Probe[], tsconfig: string): Promise<string | undefined> {
  await mkdir(join(root, KAY_DIR), { recursive: true })

  // A folder of its own, as a build and a dev server of the project may both run.
  const dir = await mkdtemp(join(root, KAY_DIR, `${PROBE_DIR}-`))
  // Where tsgo lays the output out, which it resolves links for.
  const real = realpathSync(dir)
  const lines = probes.map(({ file, name }, at) => `export const t${at} = answer(null as unknown as typeof import(${JSON.stringify(specifier(dir, file))})[${JSON.stringify(name)}])`)

  await Bun.write(join(dir, 'probe.ts'), `${WIRE_PRELUDE}\n${lines.join('\n')}\n`)
  await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ extends: resolve(root, tsconfig), compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, composite: false, incremental: false, declarationMap: false, sourceMap: false, noEmitOnError: false, outDir: 'out', rootDir: parse(root).root }, files: ['probe.ts'], include: [] }))

  try {
    const child = Bun.spawn([nativeExe(), '-p', join(dir, 'tsconfig.json')], { cwd: root, stdout: 'ignore', stderr: 'ignore' })
    const stop = setTimeout(() => child.kill(), EMIT_TIMEOUT)

    await child.exited.finally(() => clearTimeout(stop))

    // Laid out under the root of the file system, as `rootDir` says.
    const declarations = Bun.file(join(dir, 'out', relative(parse(real).root, real), 'probe.d.ts'))

    return await declarations.exists() ? await declarations.text() : undefined
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// The declarations of the last emit, when the files they were read from are the ones of `stamp`.
async function keptDeclarations(root: string, stamp: string): Promise<string | undefined> {
  try {
    const kept = await Bun.file(join(projectPaths(root).cache, DECLARATIONS_CACHE)).json() as { stamp?: string, declarations?: string }

    return kept.stamp === stamp ? kept.declarations : undefined
  }
  catch {
    return undefined
  }
}

async function keepDeclarations(root: string, stamp: string, declarations: string): Promise<void> {
  const file = join(projectPaths(root).cache, DECLARATIONS_CACHE)
  const aside = `${file}.${process.pid}`

  try {
    await mkdir(projectPaths(root).cache, { recursive: true })
    await Bun.write(aside, JSON.stringify({ stamp, declarations }))
    await rename(aside, file)
  }
  catch {
    // Only the next run is slower.
  }
  finally {
    await rm(aside, { force: true })
  }
}

// How the probe imports a module: relative, with the `.kay` extension the shadow tree answers to.
function specifier(from: string, file: string): string {
  const path = relative(from, file).split(sep).join('/')

  return path.startsWith('.') ? path : `./${path}`
}
