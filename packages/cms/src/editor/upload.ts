import { call } from 'kay'
import filesApi from '../api/files'

// Uploads a file where a file field's upload goes for `collection`, and answers the path the site serves it at; throws when the upload fails.
export async function uploadFile(collection: string, file: File, progress?: (share: number) => void): Promise<string> {
  const form = new FormData()

  form.append('file', file)

  const answer = await call(filesApi, '/:collection', { method: 'post', params: { collection }, body: form, ...progress ? { progress } : {} })

  return answer.path
}
