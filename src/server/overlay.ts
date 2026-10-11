import type { FileDiagnostic } from '../build/transform'
import type { PageError } from '../runtime'
import { relative } from 'node:path'
import process from 'node:process'
import { mappedStack } from '../build/sourcemap'
import { formatDiagnostic } from '../compiler/frame'

const STYLE = 'body{margin:0;padding:2rem;font:14px/1.5 ui-monospace,monospace;background:#fff;color:#1a1a1a}h1{font-size:1.1rem;color:#b00020;white-space:pre-wrap}h2{font-size:1rem}pre{padding:1rem;border:1px solid #ddd;overflow-x:auto}'

// Development only: what a thrown error looks like when the app has no `_error.kay`.
export function errorPage(error: PageError): string {
  const stack = error.stack !== undefined && error.stack !== '' ? `<pre>${Bun.escapeHTML(error.stack)}</pre>` : ''

  return document(`${error.status} ${error.message}`, `<h1>${Bun.escapeHTML(error.message)}</h1>${stack}`)
}

// Development only: every compile error at its `.kay` line, or the error that stopped the server from booting.
export function compileErrorPage(diagnostics: FileDiagnostic[], error: unknown): string {
  if (diagnostics.length === 0) {
    const message = error instanceof Error ? mappedStack(error) ?? error.message : String(error)

    return document('Boot failed', `<h1>The server failed to boot</h1><pre>${Bun.escapeHTML(message)}</pre>`)
  }

  // As `kay check` prints them, with the labels under the code and the note and help after it.
  const sections = diagnostics.map(diagnostic => `<pre>${Bun.escapeHTML(formatDiagnostic(diagnostic.source, relative(process.cwd(), diagnostic.file), diagnostic))}</pre>`)

  return document('Compile error', `<h1>${diagnostics.length} compile error${diagnostics.length === 1 ? '' : 's'}</h1>${sections.join('')}`)
}

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${Bun.escapeHTML(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}
