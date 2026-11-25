// @kayjs/ui KayPlugin — wires a pure CSS Grammar (`editorial | workshop | console | soft | orbit | bare`)
// and adds `kay ui-eject <grammar> [dest]` so apps can copy & own the entire look in ONE ~200-line CSS file.

import type { KayPlugin } from '@kayjs/kay/server'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type GrammarName = 'bare' | 'editorial' | 'workshop' | 'console' | 'soft' | 'orbit'

const STYLES_DIR = join(import.meta.dir, 'styles')

export function grammarCssPath(grammar: GrammarName): string {
  return grammar === 'bare'
    ? join(STYLES_DIR, 'bare.css')
    : join(STYLES_DIR, 'grammars', `${grammar}.css`)
}

/** Ejects a complete, self-contained CSS Grammar file (with bare.css inlined) into the app! */
export function ejectGrammar(root: string, grammar: GrammarName = 'editorial', destRel = 'src/styles/ui.css'): string {
  const bare = readFileSync(join(STYLES_DIR, 'bare.css'), 'utf8')
  let content: string
  if (grammar === 'bare') {
    content = bare
  }
  else {
    const rawGrammar = readFileSync(grammarCssPath(grammar), 'utf8')
    const withoutImport = rawGrammar.replace(/^@import\s+['"]\.\.\/bare\.css['"];\s*/m, '')
    content = `${bare}\n${withoutImport}`
  }

  const outPath = resolve(root, destRel)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  return outPath
}

export interface UiPluginOptions {
  /** Which pure CSS Grammar to include (default: 'editorial'). Pass `false` if importing your own CSS. */
  grammar?: GrammarName | false | undefined
}

export function ui(options: UiPluginOptions = {}): KayPlugin {
  const grammar = options.grammar === undefined ? 'editorial' : options.grammar
  return {
    name: '@kayjs/ui',
    css: grammar === false ? undefined : [grammarCssPath(grammar)],
    commands: {
      'ui-eject': (args, root) => {
        const name = (args[0] ?? 'editorial') as GrammarName
        const valid: GrammarName[] = ['bare', 'editorial', 'workshop', 'console', 'soft', 'orbit']
        if (!valid.includes(name)) {
          console.error(`Unknown grammar "${name}". Choose one of: ${valid.join(', ')}`)
          process.exit(1)
        }
        const dest = args[1] ?? 'src/styles/ui.css'
        const outPath = ejectGrammar(root, name, dest)
        console.log(`Ejected @kayjs/ui "${name}" grammar to ${outPath}`)
      },
    },
  }
}
