// `kay new <name> [--template minimal|fullstack|blog|app] [--force]` project scaffolder: copies `templates/_shared` and `templates/<template>`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { relPosix, walkAllFiles } from '../build/files'

export type ScaffoldTemplate = 'minimal' | 'fullstack' | 'blog' | 'app'

export interface ScaffoldOptions {
  template?: ScaffoldTemplate | undefined
  force?: boolean | undefined
  kayVersion?: string | undefined
}

const TEMPLATES_DIR = join(import.meta.dir, '../../templates')

export function scaffoldProject(targetDir: string, options: ScaffoldOptions = {}): { root: string, files: string[] } {
  const root = resolve(targetDir)
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'kay-app'
  const template: ScaffoldTemplate = options.template ?? 'minimal'
  const kayVersion = options.kayVersion ?? `^${pkg.version}`

  if (existsSync(root) && readdirSync(root).length > 0 && !options.force)
    throw new Error(`kay new: directory "${root}" is not empty (pass --force to overwrite)`)

  const written: string[] = []
  for (const dir of [join(TEMPLATES_DIR, '_shared'), join(TEMPLATES_DIR, template)]) {
    for (const abs of walkAllFiles(dir)) {
      const rel = relPosix(dir, abs)
      const text = readFileSync(abs, 'utf8').replaceAll('__APP_NAME__', name).replaceAll('__KAY_VERSION__', kayVersion)
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
      written.push(rel)
    }
  }
  return { root, files: written }
}
