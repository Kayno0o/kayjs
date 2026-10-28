import { acceptsFile } from '@kaynooo/kayjs-ui/lib/accept'
import { signal } from 'kay'

// What the files of one message may be, read live as the props they come from: the types `accept` names, and what a refused file says.
export interface AttachmentLimits {
  readonly accept: string
  readonly maxFiles: number
  readonly maxFileSize: number
  readonly tooBigLabel: string
  readonly fullLabel: string
  readonly refusedLabel: string
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified

export const fileKey = (file: File) => `${file.name}\n${file.size}\n${file.lastModified}`

// The files chosen for the next message, and why one was left out.
export function createAttachments(limits: AttachmentLimits) {
  const attached = signal<File[]>([])
  const problem = signal<string | undefined>(undefined)
  const accepts = (file: File) => acceptsFile(limits.accept, file)

  // Files the picker, a drop or a paste gave, that fit the message: a file past `maxFileSize` or beyond `maxFiles` is left out and says so, and one already attached is not added twice.
  function add(chosen: File[]) {
    const sized = chosen.filter(file => file.size <= limits.maxFileSize && !attached().some(known => sameFile(known, file)))
    const taken = sized.slice(0, Math.max(0, limits.maxFiles - attached().length))

    attached.set([...attached(), ...taken])

    if (sized.length < chosen.length && chosen.some(file => file.size > limits.maxFileSize))
      problem.set(limits.tooBigLabel)
    else if (taken.length < sized.length)
      problem.set(limits.fullLabel)
  }

  return {
    attached,
    problem,
    accepts,
    add,
    // The files of the picker or of a drop on the form: the kinds `accept` names are taken, and any other says so.
    take(given: File[]) {
      add(given.filter(accepts))

      if (given.some(file => !accepts(file)))
        problem.set(limits.refusedLabel)
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
