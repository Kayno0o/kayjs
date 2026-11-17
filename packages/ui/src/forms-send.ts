import type { Action, Answer, FailureData, Signal, Success } from 'kay'
import { ActionError, ActionRedirectError, ApiError, focusInvalid, untrack } from 'kay'
import { liveElements } from './field-look'
import { answerMessage } from './internal/answer-message'
import { toast } from './toast'

// What a handler's refusal says by field name: a single message goes under the empty name, as the whole form's.
function messagesOf(said: Record<string, string> | string | undefined): Record<string, string> | undefined {
  if (typeof said !== 'string')
    return said

  return said === '' ? {} : { '': said }
}

// Calls the action with the form's fields. A refusal sets the messages for each FormField, toasts the ones no field shows (or `failure` when it carries none) and focuses the first invalid field, answering undefined; what the action returned is answered inside an object, so a result of undefined is told apart.
// The schema refuses fields; the handler refuses with data of its own, which `refused` reads, a single message going under the empty name as the whole form's.
export async function callAction<Output>(form: HTMLFormElement, action: Action<never, Output>, issues: Signal<Record<string, string>>, failure: string, refused?: ((data: FailureData<Output>) => Record<string, string> | string | undefined) | undefined, onError?: ((failure: { error: unknown }) => unknown) | undefined): Promise<{ result: Answer<Success<Output>> } | undefined> {
  try {
    const called = action(new FormData(form)) as Promise<Answer<Success<Output>>> & { orThrow?: () => Promise<Answer<Success<Output>>> }

    // A function an app passes in place of an action answers its value, and throws.
    return { result: await (called.orThrow?.() ?? called) }
  }
  catch (error) {
    // The browser is going to the page the action redirected to: nothing failed.
    if (error instanceof ActionRedirectError)
      return undefined

    // Told first, before the toast, what the call was refused or failed with.
    try {
      onError?.({ error })
    }
    catch (thrown) {
      console.error('kayjs-ui: an onError callback threw', thrown)
    }

    // An action's refusal, or a route's 4xx an app's own code threw: both carry `errors` and `data`. A call with no answer and a 5xx keep `failure`.
    const failed = error instanceof ActionError || (error instanceof ApiError && error.status !== 0 && error.status < 500) ? error : undefined
    const read = failed?.data !== undefined ? refused?.(failed.data as FailureData<Output>) : undefined
    // As in `attempt`, a `refused` saying nothing leaves the words of the data itself.
    const said = read === undefined || read === '' ? answerMessage(failed?.data) : read

    await refuse(form, { ...failed?.errors, ...messagesOf(said) }, issues, failure)

    return undefined
  }
}

// Shows a refusal: the messages go to the FormFields, a message no FormField shows (a limit, or a refusal of the whole form under the empty name) is toasted rather than lost, a refusal carrying none toasts `failure`, and the first invalid field takes the focus.
async function refuse(form: HTMLFormElement, byField: Record<string, string>, issues: Signal<Record<string, string>>, failure: string): Promise<void> {
  const messages = Object.entries(byField)

  issues.set(byField)

  const painted = await showIssues(form, byField)
  // A painter that could not load shows nothing, so every message is toasted rather than lost.
  const shown = (name: string) => painted && [...form.querySelectorAll('[data-field]')].some(field => field.getAttribute('data-field') === name)

  for (const message of messages.length === 0 ? [failure] : messages.filter(([name]) => !shown(name)).map(([, message]) => message))
    toast.error(message)

  // Each FormField marks its control invalid as its message renders; the first one takes the focus, so the message is read with it.
  await focusInvalid(form)
}

// What `checkSchema` asks of an action: `validate` and the errors of `failed()`.
export interface Validating {
  form: {
    validate: (form: HTMLFormElement, field?: string) => Promise<boolean>
    failed: () => { errors: object } | undefined
  }
}

// Checks the form against the action's schema in the browser, as the server would, and puts the messages where a refusal's go. Sent, a refusal shows as a call's does and nothing is called; with a `field`, the one that lost focus, only its message changes and the focus stays. True when what was checked is accepted.
export async function checkSchema(form: HTMLFormElement, action: Validating, issues: Signal<Record<string, string>>, failure: string, field?: string): Promise<boolean> {
  try {
    const accepted = await action.form.validate(form, field)
    const errors = { ...untrack(action.form.failed)?.errors } as Record<string, string>

    if (field === undefined && !accepted) {
      await refuse(form, errors, issues, failure)
    }
    else {
      issues.set(errors)
      await showIssues(form, errors)
    }

    return accepted
  }
  catch (error) {
    // A check that cannot run leaves the form to the server.
    console.error('kayjs-ui: the form could not be checked', error)

    return true
  }
}

// Writes the messages into the FormFields a static page gave the form as children, which no script of theirs reaches in the browser; the ones inside an island draw their own. The code is a chunk of its own, fetched only for a form that holds such a field and has a message to put or take away.
// False when the messages could not be shown, the chunk failing to load.
export async function showIssues(form: HTMLFormElement, byField: Record<string, string>): Promise<boolean> {
  const fields = [...form.querySelectorAll('[data-field]')].filter((field) => {
    const frame = field.closest('[data-kui-field]')

    return !frame || !liveElements.has(frame)
  })

  if (fields.length === 0 || (Object.keys(byField).length === 0 && form.querySelectorAll('[data-form-issue]').length === 0))
    return true

  try {
    (await import('./internal/paint-issues')).paintIssues(form, byField)

    return true
  }
  catch (error) {
    console.error('kayjs-ui: the messages of a form could not be shown', error)

    return false
  }
}
