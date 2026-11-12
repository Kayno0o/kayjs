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

### Join the caller's trace

A request carrying a W3C `traceparent` header gets its server span under that parent, so a call from another service shows as one trace; kay reads the header itself, with no OpenTelemetry dependency. The response carries `traceresponse: 00-<trace id>-<span id>-<flags>` and the JSON log lines of the request (`observe: { log: 'json' }`) a `trace` field with the trace id. A header that is malformed or has an all-zero id is ignored and the request starts a trace of its own.

To read another format (B3, a baggage rule), `observe: { extract }` takes a function from the request's `Headers` to a context, the OpenTelemetry one-liner being:

```ts
import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { defineConfig } from 'kay/server'

export default defineConfig({
  observe: {
    tracer: trace.getTracer('my-site'),
    extract: headers => propagation.extract(ROOT_CONTEXT, Object.fromEntries(headers)),
  },
})
```

`extract: false` ignores incoming traces: set it on a public edge, where outsiders could send a `traceparent` with the sampled flag and force every request to be traced. The caller's `tracestate` goes on with the parent. A throwing extractor is logged as a warning and the request starts its own trace. A custom `Tracer` receives the parent as the third argument of `startSpan` and `startActiveSpan(name, options, context, fn)`, only when the request carries one (a `startActiveSpan` declaring no parameter, such as `(...args) => tracer.startActiveSpan(...args)`, gets all four, but `(name, ...rest)` or `(name, options, ...rest)` counts as a hand-written tracer of three, so declare all four or none; a hand-written tracer of three declared parameters keeps `(name, options, fn)`); its spans return `spanContext()` for the log and `traceresponse`.

## Reference

### Tracing and timing

- `observe: { serverTiming: true }` in kay.config.ts sends the `Server-Timing` header development sends on every page rendered per request in production too, and on every action, endpoint and API route, which carry `guards;dur=0.4, handler;dur=3.2` (the guards only when it has any; only the guards for an endpoint they refuse, none for an action or API route they refuse or a handler that throws; added to a `Server-Timing` the handler set itself). A page carries: `guards;dur=0.4, import;dur=0.2, loads;dur=12.6, load-0;desc="src/routes/_layout.kay";dur=3.1, load-1;desc="src/routes/blog/[slug].kay";dur=12.4, render;dur=1.8`: the guards (on a route that has any), the import of the page's modules and its loads as a whole, which run at once, then each load, layouts first, then the render.
- Anyone loading the page reads it, page file names included; an action's, endpoint's and API route's holds none.
- In development, `observe: { loadBudget: '500ms' }` sets how long a page's loads (the `loads` phase above) may take before kay warns in the log, the browser console and the dev tool's Request tab, naming the slowest `load-n`; `'300ms'` by default, `false` for no warning, and it needs no `serverTiming`.
- The handler's time is exact to 0.1 ms, so keep `serverTiming` off in production for a login or lookup route whose time tells a caller whether an account exists.
- A prerendered page has none, but one with server islands carries the timings of the loads and render that filled them.
- `tracer` takes an OpenTelemetry tracer, which kay calls without depending on OpenTelemetry: the app installs `@opentelemetry/api` and an SDK exporting the spans, as `@opentelemetry/sdk-trace-node` with an OTLP exporter, registered before the server starts, then passes `tracer: trace.getTracer('my-site')`.
- Without one, kay starts no span and the requests cost nothing more.
- A span carries the request path (`url.path`, and a route's `[slug]` as the name) and a failed one the exception message, so a path or a message holding an id, an address or a name is personal data in the tracing backend: give it the retention and access of one, and keep such values out of messages thrown.
- A page request is a server span named after its route, `GET /blog/[slug]`, with `http.request.method`, `http.route`, `url.path` and `http.response.status_code`, and inside it one span per load, `kay.load src/routes/blog/[slug].kay`, and one for the render, `kay.render ...`.
- Spans the loads start nest under theirs.
- An action call is one too, `POST /_kay/action/...`, holding the handler's spans and the page it renders back.
- A span whose work threw records the error and an error status, as does a request answered with a 5xx.
- An API request is a server span from its guards to its response, `POST /api/upload`, and its handler runs in a `kay.handler POST /api/upload` span inside it, so the spans the handler starts nest under the request's (with a tracer declaring the four parameters of OpenTelemetry's `startActiveSpan`; a hand-written one of three keeps them apart).
- Spans nest across `await` through the context manager the SDK registers, which Bun's `AsyncLocalStorage` backs.

