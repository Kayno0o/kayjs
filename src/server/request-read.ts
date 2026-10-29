import { mapStack } from '../build/sourcemap'
import { KayError } from '../compiler/errors'

const STACK_FRAME = /^at (?:.* \()?((?:\/|[A-Z]:[\\/]).+?):(\d+):\d+\)?$/i
const THIS_FOLDER = `${import.meta.dir}/`

// Where a stack's first frame outside kay's own server files, and the `also` folders, is: the page, layout, component or module that wrote the call.
export function writtenAt(stack: string, also: string[] = []): { file: string, line: number } | undefined {
  for (const frame of mapStack(stack).split('\n').slice(1)) {
    const [, file, line] = STACK_FRAME.exec(frame.trim()) ?? []

    if (file !== undefined && !file.startsWith(THIS_FOLDER) && !also.some(folder => file.startsWith(folder)))
      return { file, line: Number(line) }
  }

  return undefined
}

// The `onError` handlers of a build judging a page it renders once, which take a `RequestReadError` for their own instead of its being logged as a failure.
export const judgingReads = new WeakSet<object>()

// What a page read of its request while it was rendered at build time, where only a request holds it.
// `file` and `line` are where the read is written: a page, a layout, a component or a module, off the stack of the read.
export class RequestReadError extends KayError {
  readonly file: string | undefined
  readonly line: number | undefined

  constructor(readonly read: string) {
    super('export-server-render', `kay: a prerendered page renders once, at build time, so it has no ${read}; drop \`prerender\` from \`export const page\`, or the \`server\` mark of a server island it holds, to render it per request`)

    const at = writtenAt(this.stack ?? '')

    this.file = at?.file
    this.line = at?.line
  }
}
