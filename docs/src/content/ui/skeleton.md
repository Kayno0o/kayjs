---
description: A grey placeholder for content that is still loading, as text, an avatar or a card.
---

<Demo name="skeleton/basic" />

`shape` is `text` by default, drawing `lines` bars with the last one shorter, `avatar` for a round block, or `card` for a block. `width` and `height` take a CSS length. The pulse stops under `prefers-reduced-motion`.

## In a pending block

Screen readers never see the shapes, which are hidden from them. `label` adds a visually hidden status, so the pending block announces what is loading.

<Demo name="skeleton/pending" />
