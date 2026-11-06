import { persisted } from 'kay'

// What the visitor chose: a fixed scheme, or `system` to follow `prefers-color-scheme`.
export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

// The cookie ThemeToggle keeps the choice in, which the server reads too.
export const THEME_COOKIE = 'theme'

// The visitor's choice, kept in a cookie so the server renders with it. A value outside the three modes reads as `system`.
export function themeMode(cookie = THEME_COOKIE) {
  return persisted<ThemeMode>(cookie, 'system', { values: THEME_MODES })
}

// The scheme the page is in, `light` or `dark`, for `html(data-theme={scheme()})` in a layout: the visitor's choice from the first render, so the page never paints the other one first.
// `undefined` while the visitor follows the system, on the server and in the browser alike: no attribute is written, and `theme.css` follows `prefers-color-scheme`, as the toggle leaves `html` for a `system` choice.
export function scheme(cookie = THEME_COOKIE): 'light' | 'dark' | undefined {
  const mode = themeMode(cookie)()

  return mode === 'system' ? undefined : mode
}

// Puts the mode on `<html>` as `data-theme`, a `system` one taking it off so the stylesheet follows the system.
export function applyMode(mode: ThemeMode) {
  const root = document.documentElement

  if (mode === 'system')
    root.removeAttribute('data-theme')
  else
    root.setAttribute('data-theme', mode)
}
