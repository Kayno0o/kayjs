import { join } from 'node:path'
import { solidPlugin } from './src/compile'

export const DIST = join(import.meta.dir, 'dist')

// The client bundle, written to `dist`; `bun build.ts` runs it alone, as the bench times a build.
export async function buildClient() {
  return Bun.build({ entrypoints: [join(import.meta.dir, 'src', 'client.tsx')], outdir: DIST, target: 'browser', splitting: true, minify: true, define: { 'process.env.NODE_ENV': '"production"' }, naming: '[name]-[hash].[ext]', plugins: [solidPlugin('dom')] })
}

if (import.meta.main)
  await buildClient()
