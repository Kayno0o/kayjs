import type { PageError } from '../runtime'

const STYLE = 'body{margin:0;padding:2rem;font:14px/1.5 ui-monospace,monospace;background:#fff;color:#1a1a1a}h1{font-size:1.1rem;color:#b00020;white-space:pre-wrap}pre{padding:1rem;border:1px solid #ddd;overflow-x:auto}'

// Development only: what a thrown error looks like when the app has no `_error.kay`.
export function errorPage(error: PageError): string {
  const stack = error.stack ? `<pre>${Bun.escapeHTML(error.stack)}</pre>` : ''

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${error.status} ${Bun.escapeHTML(error.message)}</title><style>${STYLE}</style></head><body><h1>${Bun.escapeHTML(error.message)}</h1>${stack}</body></html>`
}
