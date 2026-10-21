import { ActionError, ApiError, call } from 'kay'
import filesApi from '../api/files'
import { emptyFile, tooLarge, tooLargeForServer, tooSmall } from '../upload-text'

export interface UploadRules {
  accept: string
  images: string
  maxBytes: number
}

// What an image or file field asks of its uploads beyond the server's rules.
export interface UploadLimits {
  maxSize?: number | undefined
  minWidth?: number | undefined
  minHeight?: number | undefined
}

// What the upload route answered: where the file is served, and the size of an image it could read.
export interface Uploaded {
  path: string
  width?: number | undefined
  height?: number | undefined
}

export interface UploadOptions {
  progress?: ((share: number) => void) | undefined
  signal?: AbortSignal | undefined
  limits?: UploadLimits | undefined
}

// The uploads on their way, which a save waits for and the browser asks before leaving over.
let running = 0

export function uploading(): boolean {
  return running > 0
}

function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault()
}

function track(change: 1 | -1): void {
  running += change

  if (typeof window === 'undefined')
    return

  if (running === 1 && change === 1)
    window.addEventListener('beforeunload', warnBeforeLeaving)
  else if (running === 0)
    window.removeEventListener('beforeunload', warnBeforeLeaving)
}

let rules: Promise<UploadRules | undefined> | undefined

// What the server takes, asked once; undefined when it could not be asked, the server then refusing in its own words.
export async function uploadRules(): Promise<UploadRules | undefined> {
  return rules ??= load()
}

async function load(): Promise<UploadRules | undefined> {
  try {
    return await call(filesApi, '/rules')
  }
  catch {
    rules = undefined

    return undefined
  }
}

// Throws an `ActionError` holding the reason, which `attempt` toasts in place of its generic failure.
function refused(status: number, reason: string): ActionError {
  return new ActionError(status, reason, { '': reason })
}

// What a failed upload throws: the reason for a refusal worded for the editor, else the failure as it was.
// The editor checked the size against the rules before sending, so a 413 past it can only be kay's body limit, which words nothing about the file; no wording of the message is read to tell the two apart, and with no rules to check against the route's own words are shown.
export function uploadFailure(error: unknown, file: File, limits: UploadRules | undefined): unknown {
  if (error instanceof ApiError && error.status === 413 && limits)
    return refused(413, tooLargeForServer(file.name, file.size))

  if (error instanceof ApiError && (error.status === 413 || error.status === 415 || error.status === 400))
    return refused(error.status, error.message)

  return error
}

// The pixels of an image the browser can decode, else undefined: a file it cannot read is left to the server to refuse.
async function pixelsOf(file: File): Promise<{ width: number, height: number } | undefined> {
  if (typeof createImageBitmap === 'undefined' || !file.type.startsWith('image/'))
    return undefined

  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap

    bitmap.close()

    return { width, height }
  }
  catch {
    return undefined
  }
}

// Uploads a file where a file field's upload goes for `collection`, and answers where it is served and the size of an image; throws when the upload fails, saying why when the type, the size or the pixels are refused, and with the signal's reason when `signal` aborts it.
// `limits` are the field's own, checked with the server's: the smaller size wins.
export async function uploadFile(collection: string, file: File, { progress, signal, limits: own }: UploadOptions = {}): Promise<Uploaded> {
  if (file.size === 0)
    throw refused(400, emptyFile(file.name))

  const limits = await uploadRules()
  const maxBytes = Math.min(own?.maxSize ?? Infinity, limits?.maxBytes ?? Infinity)

  if (file.size > maxBytes)
    throw refused(413, tooLarge(file.name, file.size, maxBytes))

  if (own?.minWidth !== undefined || own?.minHeight !== undefined) {
    const pixels = await pixelsOf(file)

    if (pixels && (pixels.width < (own.minWidth ?? 0) || pixels.height < (own.minHeight ?? 0)))
      throw refused(400, tooSmall(file.name, pixels.width, pixels.height, own.minWidth, own.minHeight))
  }

  const form = new FormData()

  form.append('file', file)
  track(1)

  try {
    return await call(filesApi, '/:collection', { method: 'post', params: { collection }, body: form, ...progress && { progress }, ...signal && { signal } })
  }
  catch (error) {
    throw signal?.aborted === true ? error : uploadFailure(error, file, limits)
  }
  finally {
    track(-1)
  }
}

// The uploads stored for `collection`, to pick one again; `images` leaves out the other files.
export async function listUploads(collection: string, images: boolean): Promise<{ path: string, name: string }[]> {
  return call(filesApi, '/:collection', { params: { collection }, query: { images: String(images) } })
}
