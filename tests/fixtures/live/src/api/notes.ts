import { t } from 'elysia'
import { api } from 'kay/server'

const notes = new Map<number, { id: number, title: string, at: Date }>()
let next = 1

// Notes kept in memory, for the calls an island makes: every method, a JSON body, a file.
export default api()
  .get('/', () => [...notes.values()])
  .post('/', ({ body }) => {
    const note = { id: next++, title: body.title, at: new Date(Date.UTC(2026, 0, 1)) }

    notes.set(note.id, note)

    return note
  }, { body: t.Object({ title: t.String({ minLength: 1 }) }) })
  .patch('/:id', ({ params, body, status }) => {
    const note = notes.get(params.id)

    if (!note)
      return status(404, 'No such note')

    note.title = body.title

    return note
  }, { params: t.Object({ id: t.Numeric() }), body: t.Object({ title: t.String() }) })
  .delete('/:id', ({ params }) => notes.delete(params.id), { params: t.Object({ id: t.Numeric() }) })
  .post('/attachments', ({ body }) => ({ name: body.file.name, size: body.file.size, caption: body.caption }), { body: t.Object({ file: t.File(), caption: t.String() }) })
  .get('/bytes', () => new Blob([new Uint8Array([0, 255])], { type: 'application/octet-stream' }))
  .post('/touch', () => undefined)
  .get('/post/:id', ({ params }) => `post ${params.id}`)
  .get('/slow', async () => {
    await Bun.sleep(500)

    return 'late'
  })
