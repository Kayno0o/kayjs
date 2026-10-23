import { defineContext, userOf } from 'kay/library'

// Whether the visitor has an inbox, which the `Bell` reads ahead of the render so a signed-out visitor gets none of it.
export default defineContext({ inbox: async (request: Request) => await userOf(request) !== undefined })
