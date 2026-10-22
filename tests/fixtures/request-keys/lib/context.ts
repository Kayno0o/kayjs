import { defineContext } from 'kay/library'
import { loads } from './state'

// Each key has a loader of its own, run for the pages reaching a template that reads it; the visitor is named by headers, standing in for a session and a cart.
export default defineContext({
  cartCount(request: Request) {
    loads.push('cart')

    return Number(request.headers.get('x-cart') ?? 0)
  },
  async user(request: Request) {
    loads.push('user')
    await Bun.sleep(1)

    const name = request.headers.get('x-user')

    return name === null ? null : { name }
  },
})
