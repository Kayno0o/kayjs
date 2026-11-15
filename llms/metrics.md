# Metrics for a collector

Part of [Running in production](production.md).

## Common tasks

### Serve metrics to a collector

```ts
export default defineConfig({
  ops: { metrics: { token: true } },
})
```

Prometheus or any compatible collector scrapes `/metrics` with `Authorization: Bearer <token>`, the token read from `KAY_METRICS_TOKEN`. Without `token`, only a request from this machine or a private network is answered.

## Reference

- `ops: { metrics: true }` in kay.config.ts serves `/metrics` in the Prometheus text format, for Prometheus or any compatible collector (Grafana Alloy, the OpenTelemetry collector's Prometheus receiver): `ops: { metrics: { path: '/_internal/metrics' } }` moves it. It is off by default, and a server run by `kay dev` or a static export serves none.
- It holds `kay_http_requests_total{method,route,status}` and the histogram `kay_http_request_duration_seconds{method,route}`, `kay_queue_runs_total{queue,result}` (`ok`, `retried`, `failed`; a workflow is `workflow:<name>`), `kay_job_runs_total{schedule,result}` (`ok`, `failed`, `skipped` when another process held the lock), `kay_session_events_total{event}` (`created`, `destroyed`), `kay_file_events_total{event}` (`written`, `deleted`), `kay_cache_reads_total{result}` (`hit` or `miss` of `cached` and `cache`), `kay_live_connections`, `kay_process_resident_memory_bytes` and `kay_process_uptime_seconds`.
- A page counts under its pattern, `/shop/:item`, an API route under its route, and a path nothing serves under `unmatched`, so a scan adds no series; at most 500 routes are kept, the rest read `other`. The scrape itself and the health route are not counted, nor a request an earlier hook answers (a redirect, a refusal by `proxy.key`), and a method no server knows reads `OTHER`.
- It is never public by default: only a request that reached the socket from this machine or a private network (a collector in the same compose network, a sidecar) and carries no `X-Forwarded-*`, `X-Real-IP`, `Forwarded`, `Via` or `CF-Connecting-IP` header, nor the headers `proxy.header` and `proxy.key.header` name, is answered; every other gets 403, a trailing slash, a query or the `base` in the path included. Do not forward the path from the reverse proxy: one that adds none of those headers cannot be told from a collector.
- With a token, only a request with `Authorization: Bearer <token>` is answered, from any address, for a collector reaching the server across networks: `ops: { metrics: { token: true } }` reads `KAY_METRICS_TOKEN`, `token: { env: 'COLLECTOR_TOKEN' }` another variable, `token: { file: '/run/secrets/metrics' }` a file (trimmed), a string is the token itself; a setting that gives none stops the boot. Without `token`, `KAY_METRICS_TOKEN` still counts. With no token the boot always logs a warning, as any peer on a private network reads the metrics, and a proxy on this host that forwards the path unmarked reads as a collector. `kay routes` lists the route and `kay env` the variable.
- `proxy.key` lets a request on this path past the key, as it does the health route, since the collector does not go through the proxy; the rules above still apply. An app file or page at `/metrics` keeps the path, and kay serves none there.
