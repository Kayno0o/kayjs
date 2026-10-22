import { defineContext } from 'kay/library'
import { viewerValues } from './viewer'

// The request values kayjs-auth gives every template as `ctx`, `ctx.user` and `ctx.can(role)`, read ahead of the pages reaching a template that reads `ctx`.
export default defineContext(viewerValues)
