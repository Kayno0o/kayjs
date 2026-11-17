import type { Action, Answer, FailureData, Signal, Success } from 'kay'
import type { Validating } from './forms-send'

// What a form does on a send or a blur loads when it first happens, so a page whose forms are not used yet carries none of it, nor the toast it reports with.
// A chunk that fails to load is tried once more, the second try asking the browser again.
async function load<Module>(open: () => Promise<Module>): Promise<Module> {
  try {
    return await open()
  }
  catch {
    return open()
  }
}

// Awaited here so that a rejection of the call, which the code reporting it reads once it loads, is never unhandled meanwhile.
async function settled(call: Promise<unknown>): Promise<void> {
  try {
    await call
  }
  catch {
    // The reporting code reads it.
  }
}

// The call starts at once, as a function of the page's own would, so the action is pending and the fields are read as they stand while the code that reports its answer loads. A chunk that cannot load leaves the call made and says so in the console.
export async function callAction<Output>(form: HTMLFormElement, action: Action<never, Output>, issues: Signal<Record<string, string>>, failure: string, refused?: ((data: FailureData<Output>) => Record<string, string> | string | undefined) | undefined, onError?: ((failure: { error: unknown }) => unknown) | undefined): Promise<{ result: Answer<Success<Output>> } | undefined> {
  let started: Promise<Answer<Success<Output>>> & { orThrow?: () => Promise<Answer<Success<Output>>> }

  try {
    started = action(new FormData(form)) as typeof started
  }
  catch (error) {
    started = Promise.reject(error)
  }

  void settled(started)

  try {
    // Not async: the action's own promise, with its `orThrow`, is what the code reading the answer is given back.
    // eslint-disable-next-line ts/promise-function-async
    const replay = () => started

    return await (await load(async () => import('./forms-send'))).callAction(form, replay as never, issues, failure, refused, onError)
  }
  catch (error) {
    console.error('kayjs-ui: the code that reports a form\'s answer could not load', error)

    return undefined
  }
}

// A send is checked first with `checking` set meanwhile, set here and not once the check loads: a second send meanwhile (a double Enter, Ctrl+S twice) is the form's to refuse.
export async function checkSent(form: HTMLFormElement, action: Validating, issues: Signal<Record<string, string>>, failure: string, checking: Signal<boolean>): Promise<boolean> {
  checking.set(true)

  try {
    return await checkSchema(form, action, issues, failure)
  }
  finally {
    checking.set(false)
  }
}

// A check that cannot run leaves the form to the server, as one that fails does.
export async function checkSchema(form: HTMLFormElement, action: Validating, issues: Signal<Record<string, string>>, failure: string, field?: string): Promise<boolean> {
  try {
    return await (await load(async () => import('./forms-send'))).checkSchema(form, action, issues, failure, field)
  }
  catch (error) {
    console.error('kayjs-ui: the form could not be checked', error)

    return true
  }
}

// False when the messages could not be shown. A form with no field to paint and no message to take off loads nothing.
export async function showIssues(form: HTMLFormElement, byField: Record<string, string>): Promise<boolean> {
  if (form.querySelector('[data-field]') === null || (Object.keys(byField).length === 0 && form.querySelector('[data-form-issue]') === null))
    return true

  try {
    return await (await load(async () => import('./forms-send'))).showIssues(form, byField)
  }
  catch (error) {
    console.error('kayjs-ui: the messages of a form could not be shown', error)

    return false
  }
}

// A toast of a form, the code of toasts loading with the first one.
export async function notify(tone: 'success' | 'error', message: string): Promise<void> {
  try {
    (await load(async () => import('./toast'))).toast[tone](message)
  }
  catch (error) {
    console.error('kayjs-ui: a toast could not be shown', error)
  }
}
