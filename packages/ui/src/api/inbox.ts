import { s } from 'kay'
import { userOf } from 'kay/library'
import { api, notifications } from 'kay/server'

// The signed-in user's inbox, which the `Bell` reads and changes: who is asking comes from whatever names the request's user, kayjs-auth say, never from the request's own words, so one user never reaches another's.
export default api()
  .get('/', async ({ request, status }) => {
    const user = await userOf(request)

    return user === undefined ? status(401) : notifications.inbox(user)
  })
  // Marks the notification `id` read, or every one when none is given.
  .post('/read', async ({ request, body, status }) => {
    const user = await userOf(request)

    if (user === undefined)
      return status(401)

    if (body.id === undefined)
      await notifications.markAllRead(user)
    else
      await notifications.markRead(user, body.id)

    return notifications.inbox(user)
  }, { body: s.Object({ id: s.Optional(s.String({ maxLength: 100 })) }) })
