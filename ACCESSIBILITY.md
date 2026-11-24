# Accessibility

Kay is designed to help teams ship fast, accessible web applications by default — without fighting the browser platform or shipping megabytes of JavaScript.

## Goals & Standards

- **Target baseline**: [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/) across Kay's first-party UI library (`@kayjs/ui`), starter templates (`kay new`), and documentation site (`docs/`).
- **Platform-first semantics**: Prefer native HTML elements and browser APIs over custom `<div>` reimplementations so keyboard behavior, focus management, top-layer stacking, and assistive technology announcements work reliably out of the box.
- **Progressive enhancement**: Pages render complete semantic HTML on the server (`0 KB` JS for static routes), forms work without JavaScript via server `action()` endpoints, and interactive islands hydrate progressively without blocking content.

## How Kay Implements Accessibility

### Core Framework (`@kayjs/kay`)
- **Document semantics**: Every HTML response sets `<html lang="...">` (configurable via `kay.config.ts` and localized automatically by `@kayjs/i18n`) and deduplicates `<title>` / `<meta>` tags cleanly through `<Head>`.
- **Progressive forms**: Standard-Schema `action()` handlers accept standard HTML `<form method="post">` submissions with field-level validation feedback even when JavaScript is disabled or still loading.
- **Zero-JS navigation by default**: Standard `<a href>` navigation preserves native browser history, focus reset, and screen reader page-change announcements.

### UI Library (`@kayjs/ui`)
- **Native browser primitives first**:
  - `Dialog` and `Drawer` use native `<dialog>` (`showModal()`, native `Escape` dismissal, inert background, top-layer stacking).
  - `Popover` uses the native HTML Popover API (`popover` / `popovertarget`).
  - `Accordion` uses native `<details>` / `<summary>`.
  - `Switch`, `Checkbox`, `RadioGroup`, and `Field` wrap real `<input>` and `<label>` controls with proper `for`/`id` association and `role="switch"` where appropriate.
- **Keyboard & ARIA patterns**:
  - Interactive widgets (`Tabs`, `Menu`, `Select`, `CommandPalette`, `DataTable`) implement keyboard navigation (`Arrow` keys, `Home`/`End`, `Enter`/`Space`, `Escape`), focus restoration, and WAI-ARIA attributes (`aria-selected`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-sort`).
  - `Toaster` announces notifications through an `aria-live` status region.
- **Color, contrast & motion**:
  - All built-in Style Grammars (`orbit`, `editorial`, `workshop`, `console`, `soft`) support both light and dark color schemes via CSS `light-dark()` with AA contrast across default, hover, active, and focus states.
  - Visible `:focus-visible` outlines are never removed without a clear high-contrast replacement.
  - Animations respect `@media (prefers-reduced-motion: reduce)`.

## Expectations for Contributors

When opening a pull request that touches `@kayjs/ui`, templates, or `docs/`:

1. **Keyboard test**: Verify every new or modified interactive control is reachable and operable using only `Tab`, `Shift+Tab`, `Enter`, `Space`, `Escape`, and arrow keys.
2. **Contrast check**: Verify text, icons, borders, and interactive states (default, hover, focus, disabled) remain legible in both **light** and **dark** modes.
3. **Semantic markup**: Use native elements (`<button>`, `<a>`, `<dialog>`, `<label>`, headings in order) before reaching for ARIA roles; always provide accessible names (`aria-label` or visible text) for icon-only controls.
4. **Automated tests**: Include Playwright assertions for keyboard navigation, focus handling, and ARIA states in `packages/kay/tests/ui.test.ts` when adding or changing UI primitives.

## Reporting Accessibility Issues

Accessibility defects are treated as bugs, not low-priority enhancements.

If you encounter a barrier in Kay, `@kayjs/ui`, or the documentation site, please [open an issue](https://github.com/Kayno0o/kayjs/issues) (or on [Forgejo](https://git.kaynooo.fr/kaynooo/kayjs/issues)) with:

- The package, component, or docs page affected
- Browser, OS, and assistive technology used (e.g. NVDA, VoiceOver, Orca, keyboard-only, zoom/high-contrast mode)
- Steps to reproduce and the expected vs. actual behavior
