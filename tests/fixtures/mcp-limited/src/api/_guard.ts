import { guard } from 'kay'

export default guard(({ headers, deny }) => {
  headers.set('retry-after', '30')
  deny(429, 'Slow down')
})
