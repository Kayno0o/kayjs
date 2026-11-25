// `kay build --static`: gathers the prerendered pages, client assets and public files into one folder and swaps it in as the output directory.

import type { KayApp } from '../server/index'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { precompressFile, walkAllFiles } from './files'

const LEADING_SLASH_RE = /^\//

export interface StaticExportOptions {
  /** The folder the site is assembled in; it becomes `finalOutDir`. */
  stageDir: string
  finalOutDir: string
  /** The regular build output the assets and public files are copied from. */
  outDir: string
  clientDir: string
  assetPrefix: string
  assets: string[]
  publicFiles: { files: string[], register: (relPath: string) => string }
  /** The server the pages were prerendered with, used to render `_404` when the app has one. */
  app: KayApp | undefined
  hasNotFoundFile: boolean
  stageSuffix: string
}

function copyInto(dstRoot: string, rel: string, src: string): void {
  const dst = join(dstRoot, rel)
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}

export async function exportStatic(options: StaticExportOptions): Promise<void> {
  const { stageDir, finalOutDir, outDir, clientDir, publicFiles } = options
  if (options.hasNotFoundFile && options.app !== undefined) {
    const res = await options.app.handle(new Request('http://localhost/__kay_404__'))
    if (res.status >= 500)
      throw new Error(`kay build --static: _404 page returned HTTP ${res.status}.`)
    writeFileSync(join(stageDir, '404.html'), await res.text())
  }

  // Client assets go to <stage>/_kay/..., public files to <stage>/...
  const assetDir = join(stageDir, options.assetPrefix.replace(LEADING_SLASH_RE, ''))
  for (const rel of options.assets)
    copyInto(assetDir, rel, join(clientDir, rel))
  // Also pick up files written directly into the public folder without registering them.
  const outPublicDir = join(outDir, 'public')
  for (const abs of walkAllFiles(outPublicDir))
    publicFiles.register(relative(outPublicDir, abs))
  for (const rel of publicFiles.files)
    copyInto(stageDir, rel, join(outPublicDir, rel))
  for (const abs of walkAllFiles(stageDir))
    precompressFile(abs, 128)

  // Swap the stage in only after every page and asset succeeded.
  if (!existsSync(finalOutDir)) {
    mkdirSync(dirname(finalOutDir), { recursive: true })
    renameSync(stageDir, finalOutDir)
    return
  }
  const backupDir = join(dirname(finalOutDir), `.${basename(finalOutDir)}.prev-${options.stageSuffix}`)
  renameSync(finalOutDir, backupDir)
  try {
    renameSync(stageDir, finalOutDir)
  }
  catch (err) {
    try {
      renameSync(backupDir, finalOutDir)
    }
    catch {}
    throw err
  }
  rmSync(backupDir, { recursive: true, force: true })
}
