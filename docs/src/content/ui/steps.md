---
description: A numbered row showing where the visitor is in a multi-step form, the step kept in the URL.
---

<Demo name="steps/basic" />

`Steps` is the indicator, and the step it shows lives in the URL: `?step=profile`. Each step before the current one, and each in `done`, is a link back; the others are plain text. `current` is the key of the step on screen, `url` the page's URL (`ctx.url`), whose other params every link keeps, and `param` the query param, `step` by default. Screen readers hear the current step as `aria-current="step"` and a completed one followed by `doneLabel`.

Three helpers from `@kaynooo/kayjs-ui` run the flow: `currentStep(url, keys, done)` reads the step off the URL, never one ahead of the first not done; `stepHref(url, key)` builds a link to a step; `stepDraft(ctx.cookies, name, { check })` keeps the values of each step between posts.

## A multi-step form

Each step posts to an action of its own, whose schema is that step's part of the form. The action saves the values in the draft and redirects to the next step, so back, forward and a reload all land on a real page, and nothing needs JavaScript. A refused step shows its messages as any form does. The last action reads every step's values from the draft.

```kay
--- server
import { currentStep, stepDraft, stepHref } from '@kaynooo/kayjs-ui'
import { TypeCompiler } from 'elysia/type-system'

const KEYS = ['account', 'profile', 'review'] as const
const account = s.Object({ email: s.String({ format: 'email', error: 'Enter an email' }) })
const profile = s.Object({ name: s.String({ minLength: 2, error: 'Two letters at least' }) })
const checks: Record<string, ReturnType<typeof TypeCompiler.Compile>> = { account: TypeCompiler.Compile(account), profile: TypeCompiler.Compile(profile) }

// The cookie is the visitor's to edit, so a step counts as done only while its values still pass its schema.
const draft = (cookies: Bun.CookieMap) => stepDraft(cookies, 'signup', { check: (step, values) => checks[step]?.Check(values) ?? false })

export const saveAccount = action(account, async (input, ctx) => {
  draft(ctx.cookies).save('account', input)

  return ctx.redirect(stepHref(ctx.url, 'profile'))
})

export const saveProfile = action(profile, async (input, ctx) => {
  draft(ctx.cookies).save('profile', input)

  return ctx.redirect(stepHref(ctx.url, 'review'))
})

export const finish = action(async (ctx) => {
  const kept = draft(ctx.cookies)

  if (kept.done().length < 2)
    return ctx.redirect(stepHref(ctx.url, 'account'))

  await createUser(kept.merged())
  kept.clear()

  return ctx.redirect('/welcome')
})

const done = draft(ctx.cookies).done()
const current = currentStep(ctx.url, KEYS, done)
const values = draft(ctx.cookies).merged()
---
Steps(steps={[{ key: 'account', label: 'Account' }, { key: 'profile', label: 'Profile' }, { key: 'review', label: 'Review' }]} current={current} done={done} url={ctx.url} label="Signup")

if current === 'account'
  form(action={saveAccount})
    input(field="email" value={values.email})
    error email
    button Next
else if current === 'profile'
  form(action={saveProfile})
    input(field="name" value={values.name})
    error name
    button Next
else
  p {values.name}, {values.email}
  form(action={finish})
    button Create the account
```

- The draft is a cookie of its own, `httpOnly`, an hour long by default (`maxAge`) and about 3,000 characters of JSON at most, so it suits text fields; a file or a long text goes through its own upload.
- Back keeps what was typed, since the values come from the draft. A step posted again replaces its values.
- `done()` lists only the steps whose values pass `check`, and `currentStep` sends the visitor back to the first one that does not, so a hand-edited cookie or URL skips nothing.
- `Steps` takes the standard parts: `list`, `item`, `link`, `marker` and `label`.
