import { ActionError, ApiError, call } from 'kay'
import filesApi from '../api/files'
import { emptyFile, tooLarge, tooLargeForServer } from '../upload-text'

export interface UploadRules {
  accept: string
  images: string
  maxBytes: number
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

// Uploads a file where a file field's upload goes for `collection`, and answers the path the site serves it at; throws when the upload fails, saying why when the type or the size is refused.
export async function uploadFile(collection: string, file: File, progress?: (share: number) => void): Promise<string> {
  if (file.size === 0)
    throw refused(400, emptyFile(file.name))

  const limits = await uploadRules()

  if (limits && file.size > limits.maxBytes)
    throw refused(413, tooLarge(file.name, file.size, limits.maxBytes))

  const form = new FormData()

  form.append('file', file)

  try {
    const answer = await call(filesApi, '/:collection', { method: 'post', params: { collection }, body: form, ...progress ? { progress } : {} })

    return answer.path
  }
  catch (error) {
    // Past the check above, the route's own 413 cannot happen, so one is kay's body limit, which says only that the body is too large; with no rules to check against the route's words are shown.
    if (error instanceof ApiError && error.status === 413 && limits)
      throw refused(413, tooLargeForServer(file.name, file.size))

    if (error instanceof ApiError && (error.status === 413 || error.status === 415 || error.status === 400))
      throw refused(error.status, error.message)

    throw error
  }
}
