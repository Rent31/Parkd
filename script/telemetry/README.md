# Garage telemetry test stack

A small local stack to look at Garage metrics and traces:

- [Prometheus](https://prometheus.io) scrapes Garage metrics from the admin API
- [Jaeger](https://www.jaegertracing.io) receives traces over OTLP
- [Grafana](https://grafana.com) with the Garage dashboard preloaded

## Configure Garage

Build Garage with the `telemetry-otlp` feature to export traces, then set in your config:

```toml
[admin]
api_bind_addr = "0.0.0.0:3903"
trace_sink = "http://localhost:4317"
```

The admin API must listen on an address reachable from containers, not the local loopback.
If you set `metrics_token`, uncomment the `authorization` section in `prometheus.yml`.

## Start the stack

```
cd script/telemetry
docker compose up
```

## Web interfaces

- [Grafana](http://localhost:3000): The *Garage* dashboard is preloaded, and traces can be browsed in Explore with the *Jaeger* data source.
- [Jaeger](http://localhost:16686): trace search UI
- [Prometheus](http://localhost:9090): check that the `garage` target is up under Status → Targets

Traces are kept in memory and are lost when Jaeger restarts.
Metrics are kept for 7 days.
Run `docker compose down -v` to remove all data.

## Upgrades

The versions are managed in the `.env` file.

## Alert rules

Prometheus loads `parkd-alerts.yml` for the `garage` scrape job. It reports target availability, cluster availability and degradation, low disk space, resync errors, detected block corruption, and elevated S3 server errors. The supplied thresholds are starting points and must be reviewed for each deployment. Missing metrics cannot produce a health alert; monitor scrape failures and verify that metrics are present on every node.

Alerts appear in the Prometheus UI. This local stack does not include Alertmanager or notification routing. Configure and test an Alertmanager and durable notification receiver before relying on alerts. The stack is for local use only; its anonymous Grafana access and default credentials are not suitable for production.

Validate the rules with `promtool check rules parkd-alerts.yml` and `promtool test rules parkd-alerts.test.yml` from this directory.
