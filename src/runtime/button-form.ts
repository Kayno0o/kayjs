// The attribute of the `form` kay writes around a `button(action={...})` outside any form.
export const BUTTON_FORM_ATTRIBUTE = 'data-kay-button-form'

// What an island that writes such a form passes `island()` among its message keys, so the page it renders in carries the rule for it; it is no message and is never sent to the browser.
export const BUTTON_FORM_KEY = 'kay:button-form'
