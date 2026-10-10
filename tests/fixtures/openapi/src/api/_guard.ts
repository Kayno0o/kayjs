import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (request.headers.get('x-key') !== 'open')
    deny(401, 'Key needed')
})
