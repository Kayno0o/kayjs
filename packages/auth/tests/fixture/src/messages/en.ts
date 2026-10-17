import { defineMessages } from 'kay/i18n'

// One text of kayjs-auth's pages replaced, the rest kept, and the label of the one scope with markup in it, which the pages must show as text.
export default defineMessages({
  auth: { signIn: { title: 'Welcome back' }, scopes: { 'notes:read': 'Read <b>your</b> notes', files: { read: 'Read your files' } } },
})
