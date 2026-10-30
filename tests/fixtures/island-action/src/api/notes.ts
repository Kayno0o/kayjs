import { t } from 'elysia'
import { api } from 'kay/server'

export default api().post('/', ({ body }) => ({ length: body.text.length }), { body: t.Object({ text: t.String() }) })
