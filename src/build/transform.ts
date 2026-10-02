import type { Diagnostic } from '../compiler'
import { relative } from 'node:path'
import process from 'node:process'
import { transform } from '@solidjs/compiler'
import { compileKay, formatDiagnostic } from '../compiler'

export type Target = 'dom' | 'ssr'

export interface TransformOptions {
  target: Target
  // Server output carries hydration markers and client output hydrates them, so islands can pick up server HTML.
  hydratable?: boolean
  // Island ids are relative to this directory.
  root?: string
}

export interface FileDiagnostic extends Diagnostic {
  file: string
  source: string
}

export class KayCompileError extends Error {
  override name = 'KayCompileError'

  constructor(readonly diagnostics: FileDiagnostic[]) {
    super(`\n${diagnostics.map(diagnostic => formatDiagnostic(diagnostic.source, relative(process.cwd(), diagnostic.file), diagnostic)).join('\n\n')}`)
  }
}

// .kay source to TypeScript with its JSX compiled by Solid's native compiler; Bun strips the types when it loads the result.
export function transformKay(source: string, filename: string, options: TransformOptions): string {
  const { tsx, diagnostics } = compileKay(source, filename, { root: options.root, includeServer: options.target === 'ssr' })

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics.map(diagnostic => ({ ...diagnostic, file: filename, source })))

  return transform(tsx, { filename: `${filename}.tsx`, generate: options.target, hydratable: options.hydratable ?? false }).code
}
