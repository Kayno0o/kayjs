---
description: A thin bar over the top of the page while the next page is being fetched, and a pending state on the link followed.
---

<Demo name="navigation-progress/basic" />

Put `NavigationProgress` once in the layout, with no props: it follows `navigation.pending()`, so it slides across the top of the page while a link or `navigate()` loads the next one and goes away when the page is in place. It shows after `delay` (`150ms` by default), so a page that comes at once draws nothing. It is decorative and hidden from screen readers, which hear the page swap through `aria-busy` on `<html>`. The slide stops under `prefers-reduced-motion`, the bar held still.

## Options

`pending` replaces `navigation.pending()` for a bar that stands for some other wait. `tone` is `accent` (default), `neutral`, `success`, `warning`, `danger` or `info`. `onShow` and `onHide` hear the bar come and go. `class={{ root: 'h-1' }}` restyles the root, `fixed inset-x-0 top-0 h-0.5`, and `bar` the sliding bar.

## The followed link

While a link is being followed, kay sets `data-pending` on it until the swap ends, with no script on your side. `a[data-pending]` styles it, such as dimming it or drawing a spinner after it: `a[data-pending] { opacity: 0.6 }`. Only the link followed carries it, one at a time, and a GET form that visits a page carries it too, so `form[data-pending]` works. A form post, a refresh and a visit to a page kay does not swap in place do not, and the mark goes when kay hands a page over to a full load.
