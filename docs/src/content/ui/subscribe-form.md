---
description: A subscribe form for a mailing list action, with a required email field, a notice of what the address is used for, the refused email's message under it, and a sent or failed message.
---

<Demo name="subscribe-form/basic" />

SubscribeForm is the form for the action `mail.list().form()` from [kayjs-mail](/libraries/kayjs-mail#a-mailing-list) builds, so a site writes neither the schema nor the confirmation mail. It posts without JavaScript, ties the message of a refused email to the field, and says in a notice whether the confirmation mail went out or why not.

```kay
--- server
import { mail } from '../mail'

export const subscribe = action(...mail.list().form())
---
---
import SubscribeForm from '@kaynooo/kayjs-ui/subscribe-form.kay'
---
SubscribeForm(action={subscribe} privacy="/privacy")
```

- A line under the field says what the address is used for. `noticeText` replaces it with the sender, the content and the frequency of your list, `privacy` links your privacy page after it, and `wordingId` names the version of the notice.
- The list keeps the page of the form and the id of the notice with the confirmation date, as the proof of consent.
- `label`, `submitLabel` and `sentLabel` replace the texts, which read the `ui.subscribeForm.*` messages, then kayjs-mail's `mail.list.form` ones in the page's language (English and French).
- The anti-spam fields the action asks for, the honeypot and the time stamp, are added by kay.

<ReadMore href="/libraries/kayjs-mail">The list, its limits and its confirmation mail are in kayjs-mail.</ReadMore>
