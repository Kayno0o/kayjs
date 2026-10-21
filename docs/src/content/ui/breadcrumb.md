---
description: The trail from the top of the site to the page on screen, as links.
---

<Demo name="breadcrumb/basic" />

`items` lists the trail, the top of the site first and the page on screen last. Each item is `{ label, href }`. The last item is marked as the current page and is never a link, so it needs no `href`. An earlier item without an `href` is plain text. The separators are drawn by the style, so a screen reader hears a list of links and its length.

## On a phone

From four items on, a narrow screen shows the first item, an ellipsis and the last two. The middle comes back above the small breakpoint.

## Search engines

Pass `structured` to also describe the trail as a `BreadcrumbList` in the head. Each `href` is made absolute by `site` in kay.config.ts, which it then needs. Use it on one Breadcrumb per page. The current page is listed without a URL, as search engines accept.

```kay
Breadcrumb(items={trail} label="Breadcrumb" structured)
```

## Label

`label` is required. It names the navigation for screen readers, so a page with several navigations tells them apart.
