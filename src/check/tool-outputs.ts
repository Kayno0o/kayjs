// The build step that gives a tool action's `outputSchema` to the server: the handler's return type, read through tsgo's declaration emit (output-schema.ts), recorded in the output folder under the action's file and name.
import type { CheckOptions } from '.'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, parse, relative, resolve, sep } from 'node:path'
import { KAY_DIR } from '../build/assets'
import { nativeExe } from '../compiler/native-typescript'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { projectPaths } from '../project'
import { routeMounts, scanRoutes } from '../server/routes'
import { TOOL_OUTPUTS_RECORD, toolOutputKey } from '../server/tool-outputs'
import { outputSchemasOf, WIRE_PRELUDE } from './output-schema'
import { writeShadowTypes } from './shadow-types'

// A run that does not end by then is stopped, and the tools list none: the build goes on.
const EMIT_TIMEOUT = 2 * 60_000
const PROBE_DIR = 'tool-probe'

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

    if (Object.keys(outputs).length === 0) {
      await rm(record, { force: true })

      return
    }

    const text = JSON.stringify({ outputs })

    if (!existsSync(record) || await Bun.file(record).text() !== text)
      await Bun.write(record, text)
  }
  catch {
    await rm(record, { force: true })
  }
}

async function emitted(root: string, options: CheckOptions, probes: Probe[], tsconfig: string, shadowed: boolean): Promise<Record<string, Record<string, unknown>>> {
  if (!shadowed)
    await writeShadowTypes(root, { ...options, typesOnly: true })

  const dir = join(root, KAY_DIR, PROBE_DIR)
  const lines = probes.map(({ file, name }, at) => `export const t${at} = answer(null as unknown as typeof import(${JSON.stringify(specifier(dir, file))})[${JSON.stringify(name)}])`)

  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, 'probe.ts'), `${WIRE_PRELUDE}\n${lines.join('\n')}\n`)
  await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ extends: resolve(root, tsconfig), compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, composite: false, incremental: false, declarationMap: false, sourceMap: false, outDir: 'out', rootDir: parse(root).root }, include: ['probe.ts'] }))

  try {
    const child = Bun.spawn([nativeExe(), '-p', join(dir, 'tsconfig.json')], { cwd: root, stdout: 'ignore', stderr: 'ignore' })
    const stop = setTimeout(() => child.kill(), EMIT_TIMEOUT)

    await child.exited.finally(() => clearTimeout(stop))

    const emittedFile = [...new Bun.Glob('**/probe.d.ts').scanSync({ cwd: join(dir, 'out'), dot: true })][0]

    if (emittedFile === undefined)
      return {}

    const schemas = outputSchemasOf(await Bun.file(join(dir, 'out', emittedFile)).text())
    const outputs: Record<string, Record<string, unknown>> = {}

    for (const [at, { key }] of probes.entries()) {
      const schema = schemas.get(`t${at}`)

      if (schema !== undefined)
        outputs[key] = schema
    }

    return outputs
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// How the probe imports a module: relative, with the `.kay` extension the shadow tree answers to.
function specifier(from: string, file: string): string {
  const path = relative(from, file).split(sep).join('/')

  return path.startsWith('.') ? path : `./${path}`
}
