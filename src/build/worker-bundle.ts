import type { KayPluginOptions } from './plugin'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { apiStubs } from '../server/api-modules'
import { kayPlugin } from './plugin'
import { withoutStyles } from './styles'

// What a browser build hands the process bundling one of its workers.
export interface WorkerBundle {
  entry: string
  outdir: string
  minify: NonNullable<Bun.BuildConfig['minify']>
  define: Record<string, string>
  options: KayPluginOptions
  // The modules started as workers on the way to this one, itself last.
  workers: string[]
}

// What the process prints: the name of the worker's file, every file the bundle wrote and every file it read.
export interface WorkerResult {
  name: string
  outputs: string[]
  inputs: string[]
  // A module naming a file by `import.meta.url` may ship it or bundle a worker of its own, whose files this bundle's inputs do not list.
  ships: boolean
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return undefined
  }
}

// Bun cannot start a build while a plugin of another waits, so a worker is bundled by a process of its own, which prints its file's name.
if (import.meta.main) {
  const bundle = JSON.parse(process.argv[2]!) as WorkerBundle
  const out = await Bun.build({
    entrypoints: [bundle.entry],
    outdir: bundle.outdir,
    target: 'browser',
    format: 'esm',
    minify: bundle.minify,
    define: bundle.define,
    external: bundle.options.external ?? [],
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    plugins: [withoutStyles(), ...bundle.options.api ? [apiStubs(bundle.options.api)] : [], kayPlugin(bundle.options, bundle.workers)],
    metafile: true,
    throw: false,
  })

  if (!out.success) {
    console.error(out.logs.map(log => log.position ? `${log.position.file}:${log.position.line}:${log.position.column}: ${log.message}` : log.message).join('\n'))
    process.exit(1)
  }

  // This process runs in the project's root, which the metafile's paths are relative to.
  const inputs = Object.keys(out.metafile!.inputs).map(input => resolve(input))
  const result: WorkerResult = {
    name: basename(out.outputs.find(output => output.kind === 'entry-point')!.path),
    outputs: out.outputs.map(output => output.path),
    inputs,
    ships: inputs.some(input => readText(input)?.includes('import.meta.url') !== false),
  }

  process.stdout.write(JSON.stringify(result))
}
