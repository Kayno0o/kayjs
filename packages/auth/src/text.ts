const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

// A name a visitor typed, without the control and direction characters that would reach a mail, a log or a page as markup, trimmed.
export function plainName(text: string): string {
  return text.replace(CONTROL, '').trim()
}
