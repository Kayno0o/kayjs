import type { FileDiagnostic } from '../build/transform'
import type { PageError } from '../runtime'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { underKayDev } from '../build/assets'
import { mappedStack } from '../build/sourcemap'
import { formatDiagnostic } from '../compiler/frame'

// kay's own source, whose frames fold away with the dependencies'.
const KAY_SOURCE = resolve(import.meta.dir, '..') + sep
const FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/
// The line of a compile error naming its position, as `kay check` prints it, once escaped.
const ARROW = /^( *--&gt; )(\S+:\d+:\d+)$/gm
// The lines shown around the failing one.
const BEFORE = 3
const AFTER = 2

const STYLE = `
:root { --bg: #fff; --surface: #f5f5f7; --fg: #1c1c22; --muted: #6a6a76; --border: #e2e2e8; --accent: #6d28d9; --error: #c4262e; --mark: rgb(196 38 46 / 10%); color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16161b; --surface: #202027; --fg: #ececf1; --muted: #a2a2ae; --border: #34343d; --accent: #a78bfa; --error: #ff7a7a; --mark: rgb(255 122 122 / 12%); color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2.5rem clamp(1rem, 4vw, 3rem); background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 64rem; margin: 0 auto; }
header { display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 1.5rem; }
header div { flex: 1; min-width: 0; }
.kind { margin: 0 0 .25rem; color: var(--error); font-weight: 600; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; }
h1 { margin: 0; font-size: 1.25rem; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
h2 { margin: 1.75rem 0 .5rem; color: var(--muted); font-size: 12px; letter-spacing: .05em; text-transform: uppercase; }
pre, code, .frames { font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { margin: 0 0 1rem; padding: 1rem; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.excerpt { padding: .75rem 0; }
.excerpt span { display: block; padding: 0 1rem; }
.excerpt .at { background: var(--mark); box-shadow: inset 3px 0 var(--error); }
.excerpt .caret { color: var(--error); }
.frames { margin: 0; padding: 0; list-style: none; }
.frames li { display: flex; gap: .75rem; flex-wrap: wrap; padding: .35rem 0; border-bottom: 1px solid var(--border); }
.frames .fn { color: var(--muted); }
details { margin-top: .75rem; }
summary { cursor: pointer; color: var(--muted); }
button { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.copy { flex: none; padding: .35rem .8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--fg); text-decoration: none; }
`

interface Frame {
  fn: string | undefined
  file: string
  line: number
  column: number
}

// Development only: what a thrown error looks like when the app has no `_error.kay`, its own frames first, each opening in the editor under `kay dev`, the line it failed at shown.
export function errorPage(error: PageError): string {
  const stack = error.stack ?? ''

  // A hint said in place of the message is copied along with the stack, which only holds the message.
  const copied = stack === '' ? error.message : stack.includes(error.message) ? stack : `${error.message}\n\n${stack}`

  return document(`${error.status} ${error.message}`, `${heading(`${error.status} error`, error.message)}${stackOf(stack)}${copyText(copied)}`)
}

// Development only: every compile error at its `.kay` line, or the error that stopped the server from booting.
export function compileErrorPage(diagnostics: FileDiagnostic[], error: unknown): string {
  if (diagnostics.length === 0) {
    const stack = error instanceof Error ? mappedStack(error) ?? error.message : String(error)
    const message = error instanceof Error ? error.message : stack

    return document('Boot failed', `${heading('Boot failed', message === '' ? 'The server failed to boot' : message)}${stack === message ? '' : stackOf(stack)}${copyText(stack)}`)
  }

  // As `kay check` prints them, with the labels under the code and the note and help after it.
  const texts = diagnostics.map(diagnostic => formatDiagnostic(diagnostic.source, relative(process.cwd(), diagnostic.file), diagnostic))
  const count = `${diagnostics.length} compile error${diagnostics.length === 1 ? '' : 's'}`

  return document('Compile error', `${heading('Compile error', count)}${texts.map(text => `<pre>${withPosition(text)}</pre>`).join('')}${copyText(texts.join('\n\n'))}`)
}

// The project's own frames, the first with the lines around it, those of kay and the dependencies folded; the stack as it is when none is the project's.
function stackOf(stack: string): string {
  const frames = parseFrames(stack)
  const own = frames.filter(frame => ownFile(frame.file))
  const others = frames.filter(frame => !ownFile(frame.file))

  if (own.length === 0)
    return stack === '' ? '' : `<pre>${Bun.escapeHTML(stack)}</pre>`

  const folded = others.length === 0 ? '' : `<details><summary>${others.length} frame${others.length === 1 ? '' : 's'} in kay and dependencies</summary>${frameList(others)}</details>`

  return `${excerptOf(own[0]!)}<h2>Stack</h2>${frameList(own)}${folded}`
}

function heading(kind: string, title: string): string {
  return `<header><div><p class="kind">${Bun.escapeHTML(kind)}</p><h1>${Bun.escapeHTML(title)}</h1></div><button type="button" class="copy" data-kay-copy="kay-error-text">Copy</button></header>`
}

// What Copy puts on the clipboard, as the terminal would show it.
function copyText(text: string): string {
  return `<pre id="kay-error-text" hidden>${Bun.escapeHTML(text)}</pre>`
}

function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = []

  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line)

    if (!match)
      continue

    const [, fn, location, row, column] = match
    const file = location!.startsWith('file:///') ? fileURLToPath(location!) : location!

    frames.push({ fn, file, line: Number(row), column: Number(column) })
  }

  return frames
}

function insideProject(file: string): boolean {
  const path = relative(process.cwd(), file)

  return isAbsolute(file) && !path.startsWith('..') && !isAbsolute(path)
}

// A file of the project the server runs in, not kay's nor a dependency's.
function ownFile(file: string): boolean {
  return insideProject(file) && !file.startsWith(KAY_SOURCE) && !file.includes(`${sep}node_modules${sep}`)
}

function frameList(frames: Frame[]): string {
  return `<ol class="frames">${frames.map(frame => `<li>${position(frame)}${frame.fn === undefined ? '' : `<span class="fn">${Bun.escapeHTML(frame.fn)}</span>`}</li>`).join('')}</ol>`
}

// A frame's place, as a button opening it in the editor under `kay dev`, whose inspector answers it.
function position(frame: Frame): string {
  const path = insideProject(frame.file) ? relative(process.cwd(), frame.file) : frame.file
  const text = Bun.escapeHTML(`${path}:${frame.line}:${frame.column}`)

  return underKayDev() && ownFile(frame.file) ? `<button type="button" data-kay-open="${text}">${text}</button>` : `<code>${text}</code>`
}

// A compile error's position, under its message, as a button; not a path its code frame happens to hold.
function withPosition(text: string): string {
  const escaped = Bun.escapeHTML(text)

  return underKayDev() ? escaped.replace(ARROW, (_, arrow: string, source: string) => `${arrow}<button type="button" data-kay-open="${source}">${source}</button>`) : escaped
}

// The lines around where the first of the project's frames failed, a caret under its column.
function excerptOf(frame: Frame): string {
  let lines: string[]

  try {
    lines = readFileSync(frame.file, 'utf8').split('\n')
  }
  catch {
    return ''
  }

  if (frame.line > lines.length)
    return ''

  const start = Math.max(1, frame.line - BEFORE)
  const end = Math.min(lines.length, frame.line + AFTER)
  const width = String(end).length
  const rows: string[] = []

  for (let number = start; number <= end; number++) {
    const gutter = `${String(number).padStart(width)} | `

    rows.push(`<span${number === frame.line ? ' class="at"' : ''}>${Bun.escapeHTML(gutter + lines[number - 1]!)}</span>`)

    if (number === frame.line)
      rows.push(`<span class="caret">${' '.repeat(width)} | ${' '.repeat(Math.max(0, frame.column - 1))}^</span>`)
  }

  return `<h2>${position(frame)}</h2><pre class="excerpt">${rows.join('')}</pre>`
}

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${Bun.escapeHTML(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
}
