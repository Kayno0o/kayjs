import type { KayPluginOptions } from './plugin'
import { basename } from 'node:path'
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
    throw: false,
  })

  if (!out.success) {
    console.error(out.logs.map(log => log.position ? `${log.position.file}:${log.position.line}:${log.position.column}: ${log.message}` : log.message).join('\n'))
    process.exit(1)
  }

  process.stdout.write(basename(out.outputs.find(output => output.kind === 'entry-point')!.path))
}
