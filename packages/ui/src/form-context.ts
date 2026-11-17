import { createContext } from 'kay'

// The name of the FormField around a control, which shows that field's messages: a Checkbox or Toggle of the same name leaves them to it.
export const fieldNamed = createContext<(() => string | undefined) | undefined>(undefined)

// The messages a FormDialog's last call was refused with, by field name, which each FormField inside it reads for its own `name`.
export const formIssues = createContext<(() => Record<string, string>) | undefined>(undefined)

// What a form's `validate` is: `'submit'` checks the fields against the action's schema when the form is sent, `'blur'` also each field as it loses focus, `false` leaves it to the server.
export type FormValidation = 'blur' | 'submit' | false | undefined

// The name of the field a focus left, none for a button or a control without one.
export function leftField(event: FocusEvent): string | undefined {
  const control = event.target

  return (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) && control.name !== '' ? control.name : undefined
}
