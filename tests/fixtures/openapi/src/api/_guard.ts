import { guard } from 'kay'

// A key in the header, or one the app read for the request, as a session would hold it.
export default guard(({ request, locals, deny }) => {
  if (request.headers.get('x-key') !== 'open' && (locals as { key?: string }).key !== 'open')
    deny(401, 'Key needed')
})
