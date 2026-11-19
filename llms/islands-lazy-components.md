# Islands: components that load when they first draw

The rest of [Islands](islands.md).

## Reference

### Components that load when they first draw

- A component an island imports loads on its own, with no declaration, when every tag using it sits where the island may not draw it at first paint: inside an `if`, `else`, `match` case or `@failed`, or in the lines or `@block` of a component that draws them only in such a branch (a closed `Dialog` and a `FormDialog` draw their body only when open). A tag also drawn outside a branch, a `snippet` read as a value, a dynamic tag or a server island keeps the import eager. A `for` body or a `pending` block inherits the position of the loop or `await` around it.
- What the server drew is loaded before the island hydrates (the page preloads its chunks, and the island names them in `data-lazy`), so its markup is claimed as it stands. What it did not draw loads when it first draws: a visitor reaching for the island (pointer over it, focus or touch inside it) loads every such component ahead, so the click finds the code in, except with `Save-Data`, which loads one when it opens.
- Until the code arrives the branch draws nothing, then the component in its place. A chunk that fails to load is tried again after 1 s and 3 s, a deploy that dropped it reloads the page as other chunks do, and a failure for good goes to `reportError` and `console.error`, not to `@failed`, which a render error of the branch reaches as ever; the branch tries again the next time it opens. A server-drawn chunk that fails to load leaves its island to draw that branch afresh.
- Only a component of 2,000 bytes of source or more loads this way, a chunk that only repeats code the islands load anyway is folded back into them after the bundle, so is every lazy chunk of a build when together they hold under 6,000 minified bytes (the lazy runtime would cost more), and an island that renders in the browser only (`clientOnly`) keeps its imports eager. A module with lazy imports awaits what the server drew at its top level, so a page without one carries none of this.
- A name inside a string or a whole-line comment of the file is no use of the component: only a tag or other code naming it keeps its import eager (a Table's `'Select all'` once kept its Select in every island). kayjs-ui's `Form`, `FormDialog` and `SaveForm` load the code that sends and reports a form (`forms-send`, with the toast it reports through) with the first send or blur check, tried once more when the chunk fails, so a page with a closed form-dialog does not carry it.
- `kay/dom-lazy` is the compiler's output contract for it, not API. `kay build --analyze` lists the modules of every island, a lazy component's apart from the eager ones.

A refresh, or a visit keeping its layout, keeps an island and gives it the new props in place; seed from a prop with `linked(() => prop)` ([Navigation](navigation.md#islands-kept-across-pages)).

Shared and persisted state, transitions, error fallbacks, element size, context and unique ids are in [Islands: state to unique ids](islands-state-to-ids.md).
