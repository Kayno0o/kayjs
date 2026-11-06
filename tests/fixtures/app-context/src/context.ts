import { defineContext } from 'kay/library'
import { loads } from './state'

// The app's own context: a value that is a promise and one that changes per request, the visitor named by headers.
export default defineContext({
  async cartCount(request: Request) {
    loads.push('cart')
    await Bun.sleep(1)

    return Number(request.headers.get('x-cart') ?? 0)
  },
  plan(request: Request) {
    loads.push('plan')

    return request.headers.get('x-plan') ?? 'free'
  },
})
