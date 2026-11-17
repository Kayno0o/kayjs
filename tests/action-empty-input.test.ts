import { describe, expect, it } from 'bun:test'
import { action } from '../src/runtime/action'

// `bun run check` type-checks these: each form types its context, the empty record of before 1.107 included.
const forms = {
  record: action({}, (_input, ctx) => ctx.redirect('/')),
  recordDenying: action({}, async (_input, ctx) => ctx.deny(409, { data: { reason: 'full' } })),
  recordProtected: action({}, (_input, ctx) => ctx.redirect('/'), { protect: { rateLimit: { max: 1, window: '1m' } } }),
  options: action({}, ctx => ctx.redirect('/')),
  optionsProtected: action({ protect: { rateLimit: { max: 1, window: '1m' } } }, ctx => ctx.deny(409, { data: 'x' })),
  none: action({}, () => 1),
}

describe('an action without input', () => {
  it('types its context whether its handler takes the empty input first or the context alone', () => {
    expect(Object.values(forms).every(form => typeof form === 'function')).toBe(true)
  })
})
