# Tracing

## Common tasks

### Trace requests with OpenTelemetry

`tracer` takes an OpenTelemetry tracer, the SDK registered before the server starts:

```ts
import { trace } from '@opentelemetry/api'
import { defineConfig } from 'kay/server'

export default defineConfig({
  observe: { tracer: trace.getTracer('my-site') },
})
```

## Reference

### Tracing and timing

- `observe: { serverTiming: true }` in kay.config.ts sends the `Server-Timing` header development sends on every page rendered per request in production too: `guards;dur=0.4, import;dur=0.2, loads;dur=12.6, load-0;desc="src/routes/_layout.kay";dur=3.1, load-1;desc="src/routes/blog/[slug].kay";dur=12.4, render;dur=1.8`: the guards (on a route that has any), the import of the page's modules and its loads as a whole, which run at once, then each load, layouts first, then the render.
- Anyone loading the page reads it, page file names included.
- A prerendered page has none, but one with server islands carries the timings of the loads and render that filled them.
- `tracer` takes an OpenTelemetry tracer, which kay calls without depending on OpenTelemetry: the app installs `@opentelemetry/api` and an SDK exporting the spans, as `@opentelemetry/sdk-trace-node` with an OTLP exporter, registered before the server starts, then passes `tracer: trace.getTracer('my-site')`.
- Without one, kay starts no span and the requests cost nothing more.
- A span carries the request path (`url.path`, and a route's `[slug]` as the name) and a failed one the exception message, so a path or a message holding an id, an address or a name is personal data in the tracing backend: give it the retention and access of one, and keep such values out of messages thrown.
- A page request is a server span named after its route, `GET /blog/[slug]`, with `http.request.method`, `http.route`, `url.path` and `http.response.status_code`, and inside it one span per load, `kay.load src/routes/blog/[slug].kay`, and one for the render, `kay.render ...`.
- Spans the loads start nest under theirs.
- An action call is one too, `POST /_kay/action/...`, holding the handler's spans and the page it renders back.
- A span whose work threw records the error and an error status, as does a request answered with a 5xx.
- An API request is a server span from its guards to its response, `POST /api/upload`; spans its handler starts do not nest under it, since Elysia runs the handler outside any call kay makes.
- Spans nest across `await` through the context manager the SDK registers, which Bun's `AsyncLocalStorage` backs.

