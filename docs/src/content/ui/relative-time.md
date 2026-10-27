---
description: A date worded relative to now, with the full date as a tooltip.
---

<Demo name="relative-time/basic" />

`RelativeTime` renders a `time` with the date relative to now in the page's locale, such as `3 hours ago` or `yesterday`, and the full date as a tooltip. The element takes the keyboard, so [TooltipHost](/ui/tooltip-host) shows the date there as it does under the pointer. Render one `TooltipHost` in the root layout.

`date` is a `Date`, a timestamp in milliseconds or a string `new Date` reads. A date it cannot read renders nothing.

The text keeps ticking in the browser, every second under a minute away, every minute under an hour and every hour past that. The browser starts from the moment the server rendered the page, so hydrating changes nothing.

## Wording

`options` takes what `Intl.RelativeTimeFormat` does, such as `{ style: 'short' }` for `3 hr. ago`. `dateOptions` takes what `Intl.DateTimeFormat` does for the tooltip, `{ dateStyle: 'long', timeStyle: 'short' }` by default. The tooltip is written in the time zone of the machine formatting it, the server's for the page as served, so set `timeZone` to pin one.
