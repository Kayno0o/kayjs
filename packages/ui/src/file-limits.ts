export type FileRejection = 'type' | 'size' | 'count'

export interface FileLimits {
  // Whether a file is of a type the zone takes.
  readonly accepts: (file: File) => boolean
  // The largest file in bytes; `Infinity` for none.
  readonly maxBytes: number
  // How many more files fit.
  readonly room: number
  // The files already kept, which are not taken twice.
  readonly kept?: readonly File[] | undefined
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified

// Splits files offered by a picker, a drop or a paste into the ones that fit and the ones left out, with why: `type` for those not accepted, `size` for those past `maxBytes`, `count` for the fitting ones beyond `room`. One list per reason, none empty. FileDrop and the chat components share it, so the limits read alike.
export function takeFiles(files: Iterable<File>, limits: FileLimits): { taken: File[], rejected: { files: File[], reason: FileRejection }[] } {
  const all = [...files]
  const wrongType = all.filter(file => !limits.accepts(file))
  const typed = all.filter(file => !wrongType.includes(file))
  const tooBig = typed.filter(file => file.size > limits.maxBytes)
  const fitting = typed.filter(file => file.size <= limits.maxBytes && !limits.kept?.some(kept => sameFile(kept, file)))
  const room = Math.max(0, limits.room)
  const rejected = ([[wrongType, 'type'], [tooBig, 'size'], [fitting.slice(room), 'count']] as [File[], FileRejection][])
    .filter(([group]) => group.length > 0)
    .map(([group, reason]) => ({ files: group, reason }))

  return { taken: fitting.slice(0, room), rejected }
}
