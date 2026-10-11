import type Contact from './contact.kay'

export default {
  fields: [{ label: 'Name', value: 'Ada Lovelace' }, { label: 'Email', value: 'ada@example.com', href: 'mailto:ada@example.com' }, { label: 'Phone' }],
  message: 'Hello,\n\nI would like a quote for the kitchen.\nThanks',
} satisfies Parameters<typeof Contact>[0]
