import { s } from 'kay'
import { findIcons } from 'kay/content'
import { api } from 'kay/server'

// The most icons a page holds, whatever the editor asks.
const MOST = 100

// A page of the icons of a set an `iconField` registered, which the editor's picker shows: the set stays on the server.
export default api()
  // The markup travels as plain text, which the editor vouches for itself: this route's answer carries no mark of it.
  .get('/', ({ query }) => findIcons(query.set, query.query, Math.min(query.limit, MOST), query.offset).map(({ name, icon }) => ({ name, icon: { ...icon, innerHTML: String(icon.innerHTML) } })), {
    query: s.Object({ set: s.String({ maxLength: 100 }), query: s.String({ maxLength: 200 }), limit: s.Integer({ minimum: 1 }), offset: s.Integer({ minimum: 0 }) }),
  })
