import { api, exitPreview } from 'kay/server'

export default api()
  // Leaves edit mode, clearing the cookie kay keeps it in.
  .post('/exit', ({ set }) => {
    const cookies = new Bun.CookieMap()

    exitPreview({ cookies })
    set.headers['set-cookie'] = cookies.toSetCookieHeaders()

    return { left: true }
  })
