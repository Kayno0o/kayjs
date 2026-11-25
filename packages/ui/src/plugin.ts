// @kayjs/ui KayPlugin — wires a pure CSS Grammar (`editorial | workshop | console | soft | orbit | bare`)
// and adds `kay ui-eject <grammar> [dest]` so apps can copy & own the entire look in ONE ~200-line CSS file.

import type { KayPlugin } from '@kayjs/kay/server'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { definePlugin } from '@kayjs/kay/server'

export type GrammarName = 'bare' | 'editorial' | 'workshop' | 'console' | 'soft' | 'orbit'

export const GRAMMAR_NAMES: readonly GrammarName[] = ['bare', 'editorial', 'workshop', 'console', 'soft', 'orbit']

const STYLES_DIR = join(import.meta.dir, 'styles')
const BARE_IMPORT_RE = /^@import\s+['"]\.\.\/bare\.css['"];?\s*/gm

export function grammarCssPath(grammar: GrammarName): string {
  return grammar === 'bare'
    ? join(STYLES_DIR, 'bare.css')
    : join(STYLES_DIR, 'grammars', `${grammar}.css`)
}

/** Returns the self-contained CSS source for a grammar (with `bare.css` inlined). */
export function renderGrammarCss(grammar: GrammarName, bareCss?: string): string {
  const bare = bareCss ?? readFileSync(join(STYLES_DIR, 'bare.css'), 'utf8')
  if (grammar === 'bare')
    return bare
  const rawGrammar = readFileSync(grammarCssPath(grammar), 'utf8')
  const withoutImport = rawGrammar.replace(BARE_IMPORT_RE, '')
  return `${bare}\n${withoutImport}`
}

/** Ejects a complete, self-contained CSS Grammar file (with bare.css inlined) into the app! */
export function ejectGrammar(root: string, grammar: GrammarName = 'editorial', destRel = 'src/styles/ui.css'): string {
  const outPath = resolve(root, destRel)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, renderGrammarCss(grammar))
  return outPath
}

export interface EmitGrammarsOptions {
  /** Public directory relative to `dist/public` (default: `'grammars'`). */
  dir?: string | undefined
  /** Subset of grammars to emit (default: all grammars). */
  grammars?: readonly GrammarName[] | undefined
}

export interface UiPluginOptions {
  /** Which pure CSS Grammar to include (default: 'editorial'). Pass `false` if importing your own CSS. */
  grammar?: GrammarName | false | undefined
  /** Emit standalone self-contained grammar CSS files into `public/grammars/<name>.css` for runtime switching. */
  emitGrammars?: boolean | readonly GrammarName[] | EmitGrammarsOptions | undefined
}

function resolveEmitGrammars(opt: UiPluginOptions['emitGrammars']): { dir: string, grammars: readonly GrammarName[] } | undefined {
  if (!opt)
    return undefined
  if (opt === true)
    return { dir: 'grammars', grammars: GRAMMAR_NAMES }
  if (Array.isArray(opt))
    return { dir: 'grammars', grammars: opt }
  const opts = opt as EmitGrammarsOptions
  const dir = (opts.dir ?? 'grammars').replace(/^\/+|\/+$/g, '')
  return { dir, grammars: opts.grammars ?? GRAMMAR_NAMES }
}

export function ui(options: UiPluginOptions = {}): KayPlugin {
  const grammar = options.grammar === undefined ? 'editorial' : options.grammar
  const emit = resolveEmitGrammars(options.emitGrammars)
  return definePlugin({
    name: '@kayjs/ui',
    css: grammar === false ? undefined : [grammarCssPath(grammar)],
    ...(emit === undefined
      ? {}
      : {
          build(ctx) {
            const bare = readFileSync(join(STYLES_DIR, 'bare.css'), 'utf8')
            const prefix = emit.dir ? `${emit.dir}/` : ''
            for (const g of emit.grammars)
              ctx.emitPublic(`${prefix}${g}.css`, renderGrammarCss(g, bare))
          },
        }),
    commands: {
      'ui-eject': (args, root) => {
        const name = (args[0] ?? 'editorial') as GrammarName
        if (!GRAMMAR_NAMES.includes(name)) {
          console.error(`Unknown grammar "${name}". Choose one of: ${GRAMMAR_NAMES.join(', ')}`)
          process.exit(1)
        }
        const dest = args[1] ?? 'src/styles/ui.css'
        const outPath = ejectGrammar(root, name, dest)
        console.log(`Ejected @kayjs/ui "${name}" grammar to ${outPath}`)
      },
    },
  })
}
