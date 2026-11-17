import type { Action, Answer, FailureData, Signal, Success } from 'kay'
import type { Validating } from './forms-send'

// What a form does on a send or a blur loads when it first happens, so a page whose forms are not used yet carries none of it, nor the toast it reports with.
// A chunk that fails to load is tried once more, the second try asking the browser again.
async function send(): Promise<typeof import('./forms-send')> {
  try {
    return await import('./forms-send')
  }
  catch {
    return import('./forms-send')
  }
}

export async function callAction<Output>(form: HTMLFormElement, action: Action<never, Output>, issues: Signal<Record<string, string>>, failure: string, refused?: ((data: FailureData<Output>) => Record<string, string> | string | undefined) | undefined, onError?: ((failure: { error: unknown }) => unknown) | undefined): Promise<{ result: Answer<Success<Output>> } | undefined> {
  return (await send()).callAction(form, action, issues, failure, refused, onError)
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

export async function checkSchema(form: HTMLFormElement, action: Validating, issues: Signal<Record<string, string>>, failure: string, field?: string): Promise<boolean> {
  return (await send()).checkSchema(form, action, issues, failure, field)
}

export async function showIssues(form: HTMLFormElement, byField: Record<string, string>): Promise<boolean> {
  return (await send()).showIssues(form, byField)
}
