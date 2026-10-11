import { s } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String(), tags: s.Array(s.String(), { default: [] }) }),
})
