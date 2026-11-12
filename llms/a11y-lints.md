# Accessibility lints

## Common tasks

- Set a lint's level, allow it on one line or apply its quick fix: [Lints and warnings](lints.md).

## Reference

- The `a11y` group reads markup a screen reader or a keyboard cannot use; `kay a11y` audits a built site ([Accessibility audit](a11y-audit.md)).

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `missing-alt` | deny | a11y | An `img` or `input(type="image")` with no `alt`; an extension with `satisfies: ['missing-alt']` (kayjs-ai's `imageAlt`) answers it for a server-rendered `img` whose `src` is an imported image. |
| `missing-title` | deny | a11y | An `iframe` with no `title`. |
| `unreachable-click` | deny | a11y | An `onClick` on an element no keyboard reaches, with no `role`. |
| `empty-control` | deny | a11y | A `button`, or an `a` with an `href`, with nothing for a screen reader to announce: no text, no value, no `aria-label`, an icon alone. |
| `unknown-aria` | deny | a11y | An `aria-*` attribute ARIA does not define, such as `aria-labeledby`. The quick fix writes the closest one. |
| `invalid-aria-value` | deny | a11y | An ARIA state written as text with a value ARIA does not define, such as `aria-expanded="yes"`. The quick fix writes the closest value. |
| `unknown-role` | deny | a11y | A `role` ARIA does not define, or an abstract one such as `widget`. |
| `missing-state` | deny | a11y | A `role` with no state it needs, such as a `switch` with no `aria-checked`. |
| `hidden-focusable` | deny | a11y | An element the keyboard reaches on or inside `aria-hidden="true"`. |
| `positive-tabindex` | deny | a11y | A `tabindex` above 0. |
| `link-as-button` | deny | a11y | An `a` with `onClick` and no `href`, `href="#"` or a `javascript:` one. |
| `empty-heading` | warn | a11y | An `h1` to `h6` with nothing for a screen reader to read. |
| `anchor-is-valid` | warn | a11y | An `a` with no `href`, or an empty, `#` or `javascript:` one, and no handler. |
| `redundant-role` | warn | a11y | A `role` the element already has, such as `button(role="button")`; `role="list"` on a list stays. |
| `unsupported-aria` | warn | a11y | An `aria-*` attribute the element's role does not take, such as `aria-checked` on a `button`. |
| `multiple-h1` | warn | a11y | A second `h1` in one template, branches of an `if` or `match` apart. |
| `no-access-key` | warn | a11y | An `accesskey`. |
| `click-without-key` | warn | a11y | An `onClick` on an element the keyboard reaches that no `onKeyDown`, `onKeyUp` or `onKeyPress` answers, on it or around it. |
| `interactive-tabindex` | warn | a11y | A `tabindex="0"` on a `p`, a heading, a list, an `img` or a table part. |
| `nested-control` | deny | a11y | A link, button or field inside a link or a button. |
| `duplicate-id` | deny | a11y | An id two elements of a template share, or one written out inside a `for` or a `snippet` called more than once. |
| `missing-label` | warn | a11y | An `input`, `select`, `textarea`, `meter`, `role="slider"` or `role="meter"` with no `label`, `aria-label`, `aria-labelledby` or `title`; a `placeholder` is no label. |
| `skipped-heading` | warn | a11y | A heading skipping a level after the one before it, an `h3` after an `h1`. |
| `autofocus` | warn | a11y | `autofocus` outside a `dialog`, on an element without `tabindex="-1"`. |
| `dangling-label` | warn | a11y | A `label(for="...")` pointing at an id nothing in the template has. |
| `missing-captions` | warn | a11y | A `video` that is not `muted` with no captions `track`. |
| `unannounced-click` | warn | a11y | An `onClick` on an element whose `role` names no widget, such as `presentation` or `region`; a `dialog` role or `aria-modal` (not `"false"`) is left alone. |
| `dangling-aria` | warn | a11y | An `aria-labelledby` or `aria-describedby` listing an id nothing in the template has. |
| `unreachable-tooltip` | warn | a11y | A `data-tooltip` on an element the keyboard never reaches and no `aria-label` (ignored on a role-less `span` or `div`), `aria-labelledby` or `aria-describedby` speaks for, and whose content is not just the tooltip's own text; `data-hint` is the pointer-only form. |
| `hand-tooltip` | warn | a11y | A `span` with `data-tooltip` and `tabindex="0"` written by hand in a file importing kayjs-ui, which its `Tooltip` renders. `kay check --fix` writes `Tooltip(text=...)` and its import. |
| `uncontrolled-autoplay` | warn | a11y | A `video` or `audio` with `autoplay` and no `controls`. |
| `meta-refresh` | warn | a11y | A `meta(http-equiv="refresh")` reloading or leaving the page after a delay. |
| `ungrouped-radios` | warn | a11y | Radios sharing a `name` outside a `fieldset` or a `role="radiogroup"`. |
| `section-not-a-link` | warn | a11y | A `section` on anything but an `a` with an `href`. |
| `table-without-header` | warn | a11y | A `table` with no `th`, unless it has `role="presentation"` or holds a component, slot or block. |
| `fieldset-without-legend` | warn | a11y | A `fieldset` with no `legend`, `aria-label` or `aria-labelledby`. |
| `mouse-only-event` | warn | a11y | `onMouseOver` or `onMouseEnter` with no `onFocus` or `onFocusIn`, `onMouseOut` or `onMouseLeave` with no `onBlur` or `onFocusOut`. |
| `unstructured-page` | warn | a11y | A prerendered page with no `main` (or `role="main"`) or no `h1`: reported by `kay build`, no `// kay-allow` comment reaches it. |
| `redundant-alt` | warn | a11y | Alt text that is a filename or says it is an image. |
