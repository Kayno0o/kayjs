import type { Drafts } from '../drafts'
import type { EntryRef } from '../kay/contract'
import type { FieldMarker, MarkedField } from '../markers'
import { messageOf, toast } from '@kaynooo/kayjs-ui'
import { announce } from '@kaynooo/kayjs-ui/announce'
import { acceptsFile } from '@kaynooo/kayjs-ui/lib/accept'
import { wording } from 'kay/words'
import { entryKey, fieldsAt } from '../markers'
import { notTaken } from '../upload-text'
import { setImageSize } from './image-value'
import { fieldOfMarker, holdEntry, isBusy, isLoaded, untilSettled } from './inline'
import { openEntry } from './opened'
import { OWN } from './own'
import { uploadDenied, uploadFile, uploadRules } from './upload'

// The image under the pointer or the focus on the page, which the editor offers to replace: an element rendering an image field in an attribute (`<img src>` marked `data-kay-field-src`). A file dropped on it replaces it too.
export interface ImageBar {
  entry: EntryRef
  path: string
  label: string
  accept: string | undefined
  style: string
}

export interface ImageWatch {
  destroy: () => void
}

// A path through a list item, which a move or a removal of the page's list bars would shift.
const IN_LIST = /(?:^|\.)\d+(?:\.|$)/
const BAR = 'data-kcms-image-bar'
const DROPPING = 'data-kcms-dropping'
// The bar's box, which keeps it inside the image and the window.
const SIZE = 40
const MARGIN = 8

// The marked image under a node, none while its entry's form has not loaded to say the field is an image.
function imageAt(node: Node | undefined, drafts: Drafts): { found: MarkedField, label: string, accept: string | undefined } | undefined {
  if (!node || (node instanceof Element ? node : node.parentElement)?.closest(OWN))
    return undefined

  for (const found of fieldsAt(node)) {
    const field = found.attribute === undefined || !(found.element instanceof HTMLElement) || typeof found.marker.path !== 'string' ? undefined : fieldOfMarker(found.marker, drafts)

    if (field?.kind === 'image')
      return { found, label: field.label, accept: field.upload?.accept?.join(',') }
  }

  return undefined
}

// The marked image under a node whose entry has not loaded, which may be an image field: a drop on it is kept from the browser and replaces it once the entry has loaded.
function pendingImageAt(node: Node | undefined): MarkedField | undefined {
  if (!node || (node instanceof Element ? node : node.parentElement)?.closest(OWN))
    return undefined

  return fieldsAt(node).find(found => found.attribute === 'src' && found.element instanceof HTMLImageElement && typeof found.marker.path === 'string' && !isLoaded(found.marker))
}

function barOf(found: MarkedField, label: string, accept: string | undefined): ImageBar | undefined {
  const box = found.element.getBoundingClientRect()
  const right = Math.min(box.right, window.innerWidth)
  const top = Math.max(box.top, 0)
  const bottom = Math.min(box.bottom, window.innerHeight)

  // Too little of it shows to put a button on.
  if (right - Math.max(box.left, 0) < SIZE + MARGIN || bottom - top < SIZE + MARGIN)
    return undefined

  return { entry: found.marker, path: found.marker.path as string, label, accept, style: `left: ${right - SIZE - MARGIN}px; top: ${top + MARGIN}px` }
}

function sameBar(left: ImageBar | undefined, right: ImageBar | undefined): boolean {
  if (!left || !right)
    return left === right

  return left.style === right.style && left.path === right.path && left.accept === right.accept && left.label === right.label && entryKey(left.entry) === entryKey(right.entry)
}

// Offers the replace button over the page's images while the editor is open, and takes a file dropped on one.
export function watchImages(drafts: Drafts, show: (bar: ImageBar | undefined) => void, replace: (bar: ImageBar, file: File) => void): ImageWatch {
  const follow = new AbortController()
  const { signal } = follow
  let current: { found: MarkedField, label: string, accept: string | undefined } | undefined
  let dropping: Element | undefined
  let shown: ImageBar | undefined

  const offer = (next: typeof current) => {
    const bar = next && barOf(next.found, next.label, next.accept)

    current = next

    // A scroll or a resize that moved nothing writes nothing, as the bar is a signal the editor renders from.
    if (sameBar(bar, shown))
      return

    shown = bar
    show(bar)
  }
  const inBar = (node: EventTarget | null) => node instanceof Element && node.closest(`[${BAR}]`) !== null
  const reached = (event: Event) => {
    if (inBar(event.target) || (event instanceof FocusEvent && inBar(event.relatedTarget)))
      return

    offer(imageAt(event.target instanceof Node ? event.target : undefined, drafts))
  }
  const refresh = () => {
    if (current)
      offer(current)
  }
  const pendingTarget = (node: Node | undefined) => {
    const found = pendingImageAt(node)

    return found && { found, label: '', accept: undefined }
  }
  const stopDrop = () => {
    dropping?.removeAttribute(DROPPING)
    dropping = undefined
  }

  document.addEventListener('pointerover', reached, { passive: true, signal })
  document.addEventListener('focusin', reached, { signal })
  document.documentElement.addEventListener('pointerleave', () => offer(undefined), { signal })
  addEventListener('scroll', refresh, { capture: true, passive: true, signal })
  addEventListener('resize', refresh, { passive: true, signal })
  document.addEventListener('dragover', (event) => {
    const node = event.target instanceof Node ? event.target : undefined
    const target = event.dataTransfer?.types.includes('Files') === true ? imageAt(node, drafts) ?? pendingTarget(node) : undefined

    if (!target) {
      stopDrop()

      return
    }

    event.preventDefault()

    if (dropping !== target.found.element) {
      stopDrop()
      dropping = target.found.element
      dropping.setAttribute(DROPPING, '')
    }
  }, { signal })
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null)
      stopDrop()
  }, { signal })
  document.addEventListener('drop', (event) => {
    const node = event.target instanceof Node ? event.target : undefined
    const target = imageAt(node, drafts) ?? pendingTarget(node)
    const [file] = event.dataTransfer?.files ?? []

    stopDrop()

    if (!target || !file)
      return

    event.preventDefault()

    const bar = { entry: target.found.marker, path: target.found.marker.path as string, label: target.label, accept: target.accept, style: '' }

    replace(bar, file)
  }, { signal })

  return {
    destroy() {
      follow.abort()
      stopDrop()
      shown = undefined
      show(undefined)
    },
  }
}

// Uploads a file where the image field's uploads go and sets it as the field's value, with the size beside it the schema keeps. A file the field does not take, a refusal and a session that ended are toasted in the editor's words, as the form shows them under the field. An entry still a row is opened and waited for first, and an image of a list item holds the entry's lists still until it has landed, so it lands in its item.
export async function replaceImage(drafts: Drafts, bar: Pick<ImageBar, 'entry' | 'path' | 'label'>, file: File): Promise<void> {
  const marker: FieldMarker = { ...bar.entry, path: bar.path }

  if (!isLoaded(marker)) {
    openEntry(marker)
    await untilSettled(marker)
  }

  const field = fieldOfMarker(marker, drafts)

  if (field?.kind !== 'image' || isBusy(marker))
    return

  const release = IN_LIST.test(bar.path) ? holdEntry(marker) : undefined

  try {
    const denied = await uploadDenied()

    if (denied !== undefined) {
      toast.error(denied)

      return
    }

    const accept = field.upload?.accept?.join(',') ?? (await uploadRules())?.images

    if (accept !== undefined && !acceptsFile(accept, file)) {
      toast.error(notTaken(file, accept))

      return
    }

    const landed = await uploadFile(bar.entry.collection, file, { limits: field.upload })

    drafts.set(bar.entry, bar.path, landed.path)
    setImageSize(drafts, bar.entry, bar.path, field, landed.path, landed.width !== undefined && landed.height !== undefined ? { width: landed.width, height: landed.height } : undefined)
    announce(wording('cms.pageImage.replaced', '{field} replaced', { field: field.label }))
  }
  catch (error) {
    toast.error(messageOf(error, wording('cms.file.failure', 'Could not upload')))
  }
  finally {
    release?.()
  }
}
