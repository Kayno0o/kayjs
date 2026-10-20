import { mapStack } from '../build/sourcemap'
import { KayError } from '../compiler/errors'

const STACK_FRAME = /\(?((?:\/|[A-Z]:[\\/])[^():]+):(\d+):\d+\)?$/i
const THIS_FOLDER = import.meta.dir

// The `onError` handlers of a build judging a page it renders once, which take a `RequestRead` for their own instead of its being logged as a failure.
export const judgingReads = new WeakSet<object>()

// What a page read of its request while it was rendered at build time, where only a request holds it.
// `file` and `line` are where the read is written: a page, a layout, a component or a module, off the stack of the read.
export class RequestRead extends KayError {
  readonly file: string | undefined
  readonly line: number | undefined

  constructor(readonly read: string) {
    super('export-server-render', `kay: a prerendered page renders once, at build time, so it has no ${read}; drop \`prerender\` from \`export const page\`, or the \`server\` mark of a server island it holds, to render it per request`)

    for (const frame of mapStack(this.stack ?? '').split('\n').slice(1)) {
      const [, file, line] = STACK_FRAME.exec(frame.trim()) ?? []

      if (file !== undefined && !file.startsWith(THIS_FOLDER)) {
        this.file = file
        this.line = Number(line)

        return
      }
    }
  }
}
