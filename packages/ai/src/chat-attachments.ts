import type { ByteSize } from 'kay/library'
import { takeFiles } from '@kayjs/ui/lib/file-limits'
import { byteCount, signal } from 'kay'

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024

// The bytes a `maxSize` stands for, 5 MB when none is given: bytes or `'2mb'`.
export function fileSizeLimit(size: ByteSize | undefined): number {
  if (size === undefined)
    return DEFAULT_MAX_SIZE

  const bytes = byteCount(size)

  if (bytes === undefined)
    throw new Error(`kay: the maxSize of Chat is ${JSON.stringify(size)}; it takes a positive size, bytes or a string such as '2mb'`)

  return bytes
}

// What the files of one message may be, read live as the props they come from, and what a refused file says.
export interface AttachmentLimits {
  // Whether a file is of a type `accept` names: given by the Chat, so kayjs-ui stays an optional peer that only the chat components import.
  readonly accepts: (file: File) => boolean
  readonly maxFiles: number
  readonly maxSize: ByteSize | undefined
  readonly tooBigLabel: string
  readonly fullLabel: string
  readonly refusedLabel: string
}

export const fileKey = (file: File) => `${file.name}\n${file.size}\n${file.lastModified}`

// The files chosen for the next message, and why one was left out.
export function createAttachments(limits: AttachmentLimits) {
  const attached = signal<File[]>([])
  const problem = signal<string | undefined>(undefined)
  const { accepts } = limits

  return {
    attached,
    problem,
    accepts,
    // The files of the picker, a drop or a paste, split as a FileDrop splits them: a file of a kind `accept` does not name, past `maxSize` or beyond `maxFiles` is left out and says so, and one already attached is not added twice.
    take(given: File[]) {
      const { taken, rejected } = takeFiles(given, { accepts, maxBytes: fileSizeLimit(limits.maxSize), room: limits.maxFiles - attached().length, kept: attached() })
      const reasons = new Set(rejected.map(item => item.reason))

      attached.set([...attached(), ...taken])

      if (reasons.has('type'))
        problem.set(limits.refusedLabel)
      else if (reasons.has('size'))
        problem.set(limits.tooBigLabel)
      else if (reasons.has('count'))
        problem.set(limits.fullLabel)
    },
    remove(file: File) {
      attached.set(attached().filter(known => known !== file))
      problem.set(undefined)
    },
    // The files of a message taken back, ahead of those chosen since.
    restore(files: File[]) {
      attached.set([...files, ...attached()])
    },
    clear() {
      attached.set([])
      problem.set(undefined)
    },
  }
}

export type Attachments = ReturnType<typeof createAttachments>
