import { guard } from 'kay'

export default guard(({ deny }) => {
  deny(403, 'Admins only')
})
