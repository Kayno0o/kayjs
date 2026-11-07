import type { Diagnostic, Fix, KayFile, Span } from './ast'
import { codeOf } from './script-fence'

// `// kay-island` or `// kay-static` on a line of its own in a script or a module fence: the form that `--- island` and `--- static` replace, read for three minors and rewritten by `kay upgrade`.
const MARKER = /^[ \t]*\/\/[ \t]*kay-(island|static)[ \t]*$/gm

const SCRIPT_HEADER = /^---(?:[ \t]+script)?/

export type PinKind = 'island' | 'static'

// What the author pins a component to, by a fence line or by the old comment.
export interface IslandPin extends Span {
  kind: PinKind
  comment: boolean
}

// The comment, whole line from its first space, its end before the line break.
export interface IslandComment extends Span {
  kind: PinKind
}

// The comment is code only where it opens a comment: `codeOf` leaves one space for each comment, string or template it skips, so the line adds one character after a statement and none inside a template literal or a block comment, which swallow it.
function opensComment(text: string, slashes: number, end: number): boolean {
  return codeOf(text.slice(0, end)).length === codeOf(text.slice(0, slashes)).length + 1
}

export function islandComment(file: KayFile): IslandComment | undefined {
  for (const fence of [file.script, file.module]) {
    if (fence === undefined)
      continue

    const text = file.source.slice(fence.start, fence.end)

    for (const found of text.matchAll(MARKER)) {
      if (opensComment(text, found.index + found[0].indexOf('//'), found.index + found[0].length))
        return { kind: found[1] as PinKind, start: fence.start + found.index, end: fence.start + found.index + found[0].length }
    }
  }

  return undefined
}

// A fence line wins over a comment.
export function islandPin(file: KayFile, comment: IslandComment | undefined = islandComment(file)): IslandPin | undefined {
  if (file.pin !== undefined)
    return { ...file.pin, comment: false }

  return comment === undefined ? undefined : { ...comment, comment: true }
}

// The fix of the lint: the comment deleted with its line, and the script fence line written with the pin unless a fence line says it or `--- client` is an island already.
// A static pin the fence cannot take (`--- client`, no script fence, one that is not the comment's) has no fix.
function rewrite(file: KayFile, comment: IslandComment): Diagnostic['fixes'] {
  const source = file.source
  const lineEnd = source[comment.end] === '\r' ? comment.end + 2 : comment.end + 1
  const deletion = { start: comment.start, end: Math.min(lineEnd, source.length), text: '' }
  const script = file.script

  if (script === undefined || comment.start < script.start || comment.end > script.end)
    return undefined

  if (file.pin !== undefined || (file.client !== undefined && comment.kind === 'island'))
    return [{ title: 'Delete the comment', edits: [deletion], safe: true }]

  const line = file.scriptLine

  if (file.client !== undefined || line === undefined)
    return undefined

  const header = source.slice(line.start, line.end)
  const named = SCRIPT_HEADER.exec(header)

  if (named === null)
    return undefined

  // `// kay-island` only silenced `promoted-island`: a component whose chunk reaches no island stayed static, and `--- island` hydrates it on every page.
  return [{ title: `Write \`--- ${comment.kind}\``, edits: [{ start: line.start, end: line.start + named[0].length, text: `--- ${comment.kind}` }, deletion], safe: comment.kind === 'static' }]
}

export function commentLint(file: KayFile, comment: IslandComment): Diagnostic {
  return { start: comment.start, end: comment.end, code: 'island-comment', message: `\`// kay-${comment.kind}\` is written \`--- ${comment.kind}\` on the fence line since 1.92`, note: 'a fence line is parsed, where the comment was matched in the source text', help: `write \`--- ${comment.kind}\` in place of \`---\` and delete the comment`, fixes: rewrite(file, comment), checkOnly: true }
}

// The fix of a component passing an island what only an island is sent: its script fence line written `--- island`, a fence opened for a template with none, a `--- static` made `--- island`. None for a component that is an island already or one that renders on the server only.
export function islandFence(file: KayFile): Fix | undefined {
  const title = 'Write `--- island`'

  if (file.server !== undefined || file.client !== undefined || file.pin?.kind === 'island')
    return undefined

  if (file.pin !== undefined)
    return { title, edits: [{ start: file.pin.start, end: file.pin.end, text: 'island' }] }

  const line = file.scriptLine

  if (line === undefined)
    return { title, edits: [{ start: 0, end: 0, text: '--- island\n---\n' }] }

  const named = SCRIPT_HEADER.exec(file.source.slice(line.start, line.end))

  return named === null ? undefined : { title, edits: [{ start: line.start, end: line.start + named[0].length, text: '--- island' }] }
}

// A pin on a page, a layout or a special page: they render on the server and are never islands.
export function markerMismatch(pin: IslandPin, route: boolean): Diagnostic[] {
  if (!route || pin.kind !== 'island')
    return []

  const written = pin.comment ? '`// kay-island`' : '`--- island`'

  return [{ start: pin.start, end: pin.end, code: 'island-marker', message: `A page, a layout or a special page renders on the server and is never an island, and ${written} says it is one`, note: 'an island is a component a page renders', help: 'delete it, and move what needs the browser to a component of its own', checkOnly: true }]
}
