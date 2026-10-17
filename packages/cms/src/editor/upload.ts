import { ActionError, ApiError, call } from 'kay'
import filesApi from '../api/files'

export interface UploadRules {
  accept: string
  images: string
  maxBytes: number
}

const MEGABYTE = 1024 * 1024

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

function megabytes(bytes: number): string {
  return `${Math.round(bytes / MEGABYTE * 10) / 10} MB`
}

// Throws an `ActionError` holding the reason, which `attempt` toasts in place of its generic failure.
function refused(status: number, reason: string): ActionError {
  return new ActionError(status, reason, { '': reason })
}

// Uploads a file where a file field's upload goes for `collection`, and answers the path the site serves it at; throws when the upload fails, saying why when the type or the size is refused.
export async function uploadFile(collection: string, file: File, progress?: (share: number) => void): Promise<string> {
  const limits = await uploadRules()

  if (limits && file.size > limits.maxBytes)
    throw refused(413, `${file.name || 'The file'} is ${megabytes(file.size)}, over the ${megabytes(limits.maxBytes)} an upload may be`)

  const form = new FormData()

  form.append('file', file)

  try {
    const answer = await call(filesApi, '/:collection', { method: 'post', params: { collection }, body: form, ...progress ? { progress } : {} })

    return answer.path
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 413)
      throw refused(413, `${file.name || 'The file'} is ${megabytes(file.size)}, over what an upload may be`)

    if (error instanceof ApiError && error.status === 415)
      throw refused(415, error.message)

    throw error
  }
}
