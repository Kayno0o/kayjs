import type { Drafts } from '../drafts'
import type { Field } from '../fields'
import type { EntryRef } from '../kay/contract'
import { siblingPath } from '../paths'
import { sizeOfPath } from '../upload-text'

// What a new path of an image field takes along with it: the size of the image beside it when the schema keeps one (the upload's answer, else the size kay's storage put in the name of a file picked or typed; a path with none leaves no size behind that would describe the old image), and no alt text once the image is gone, as it described that image.
export function setImageSize(drafts: Drafts, entry: EntryRef, path: string, field: Field, next: string, uploaded?: { width: number, height: number }): void {
  if (field.kind !== 'image')
    return

  const size = uploaded ?? sizeOfPath(next)

  if (next === '' && field.upload?.alt !== undefined)
    drafts.set(entry, siblingPath(path, field.upload.alt.key), undefined)

  if (field.upload?.width !== undefined)
    drafts.set(entry, siblingPath(path, field.upload.width.key), size?.width)

  if (field.upload?.height !== undefined)
    drafts.set(entry, siblingPath(path, field.upload.height.key), size?.height)
}
