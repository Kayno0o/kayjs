---
description: A contact form for an action, with the name, email and message fields, each refused field's message under it, and a sent or failed message.
---

<Demo name="contact-form/basic" />

ContactForm is the form for the action `contactForm` from [kayjs-mail](/libraries/kayjs-mail#a-contact-form) builds, so a site writes neither the schema, the error mapping nor the mail wrapper. It posts without JavaScript, shows the message of each refused field under it, and says in a notice whether the message went out or why not.

```kay
--- server
import { contactForm } from '@kaynooo/kayjs-mail'
import { mail } from '../mail'

export const contact = action(...contactForm(mail, { reach: 'hello@example.com' }))
---
---
import ContactForm from '@kaynooo/kayjs-ui/contact-form.kay'
---
ContactForm(action={contact})
```

- Fields beyond the name, email and message go in as the children, between the email and the message, each in a [FormField](/ui/form-field) with `issue={contact.error('topic')}`. They are named with `name`, as `field` is only valid in the form itself.
- `nameLabel`, `emailLabel`, `messageLabel`, `submitLabel` and `sentLabel` replace the texts, which read the `ui.contactForm.*` messages, then kayjs-mail's `mail.contact.form` ones in the page's language (English and French), and are English without them, and `rows` sets the message box's height.
- When the action asks for a consent (`consent: true` in `contactForm`), the form draws the checkbox with `consentLabel`, and links the privacy page when `privacy` is given: `ContactForm(action={contact} privacy="/privacy")`. `privacyLabel` replaces the link's text, which opens in a new tab so the message is kept.
- Only the field `consent: true` marks counts: an extra field of your own named `consent`, or a hand-written schema, gets no box. Write `consent` on the form to draw it anyway, which you need inside an island, where the action carries no schema.
- The anti-spam fields the action asks for, the honeypot and the time stamp, are added by kay.

<ReadMore href="/libraries/kayjs-mail">The action, its limits and its refusals are in kayjs-mail.</ReadMore>
