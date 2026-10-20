import { t } from 'elysia'
import { collection } from 'kay/content'

export const notes = collection('content/notes', {
  schema: t.Object({ title: t.String() }),
})
