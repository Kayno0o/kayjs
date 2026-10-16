// A process that ends while it still holds a rejection nothing took.
import '../../../src/runtime/await.server'

void Promise.reject(new Error('forgotten'))
