import { api, s } from 'kay/server'
import { wording } from 'kay/words'

// A validator that is no TypeBox schema, as Standard Schema libraries are: dotted paths, its own messages.
const standard = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => {
      const body = value as { title?: unknown, nested?: { n?: unknown } }
      const issues = [
        ...typeof body.title === 'string' ? [] : [{ message: 'Title needed', path: ['title'] }],
        ...typeof body.nested?.n === 'number' ? [] : [{ message: 'Number needed', path: ['nested', 'n'] }],
      ]

      return issues.length > 0 ? { issues } : { value }
    },
  },
}

export default api()
  .post('/standard', () => ({ ok: true }), { body: standard as never })
  .post('/throwing', () => ({ ok: true }), { body: s.Object({ name: s.String({ error: () => {
    throw new Error('outside a locale')
  } }) }) })
  .post('/worded', () => ({ ok: true }), { body: s.Object({ name: s.String({ error: () => wording('words.refused', 'Refused') }) }) })

  .post('/photo', () => ({ ok: true }), { body: s.Object({ photo: s.File({ type: 'image/png' }) }) })
  .post('/no-input', () => ({ ok: true }))
  .post('/own-422', () => ({ ok: true }), { body: s.Object({ a: s.String() }), response: { 200: s.Object({ ok: s.Boolean() }), 422: s.Object({ mine: s.Boolean() }) } })
