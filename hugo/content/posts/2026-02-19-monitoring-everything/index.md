---
title: "Monitoring Everything: Prometheus, Grafana, and Loki on k3s"
date: 2026-02-19T20:00:00-06:00
draft: false
author: "zolty"
description: "A comprehensive look at the monitoring stack powering the homelab: kube-prometheus-stack for metrics, Loki for logs, custom dashboards, alert tuning, and the performance benchmarks I ran to validate the platform."
tags: ["prometheus", "grafana", "loki", "monitoring", "kubernetes", "homelab"]
categories: ["Operations"]
cover:
  image: "/images/covers/operations.svg"
  alt: "Monitoring stack"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

After running the cluster for nearly two weeks, today I took a step back to document and optimize the monitoring stack. This covers kube-prometheus-stack (Prometheus + Grafana + AlertManager), Loki for log aggregation, custom dashboards for every service, alert tuning to reduce noise, and the cluster-wide performance benchmarks I ran to establish baseline metrics.

## The Monitoring Architecture

```
┌──────────────────────────────────────────────────┐
│                  Grafana                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Metrics  │  │   Logs   │  │  Alerts  │       │
│  │ Explorer │  │ Explorer │  │  Rules   │       │
│  └──────┬───┘  └──────┬───┘  └──────┬───┘       │
└─────────┼──────────────┼─────────────┼───────────┘
          │              │             │
    ┌─────┴─────┐  ┌─────┴─────┐      │
    │Prometheus │  │   Loki    │      │
    │ (metrics) │  │  (logs)   │      │
    └─────┬─────┘  └─────┬─────┘      │
          │              │       ┌─────┴──────┐
   ┌──────┴──────┐ ┌─────┴────┐ │AlertManager│
   │ Exporters   │ │Promtail  │ │  → Slack   │
   │ node        │ │(log      │ └────────────┘
   │ kube-state  │ │ shipper) │
   │ cAdvisor    │ └──────────┘
   │ custom      │
   └─────────────┘
```

## kube-prometheus-stack

The foundation is `kube-prometheus-stack`, deployed via Helm. This single chart installs:

- **Prometheus**: Time-series metrics collection and storage
- **Grafana**: Visualization and dashboarding
- **AlertManager**: Alert routing and notification
- **node-exporter**: Host-level metrics (CPU, memory, disk, network)
- **kube-state-metrics**: Kubernetes object state (pod status, deployment replicas, etc.)
- **Recording rules**: Pre-computed metrics for common queries

```bash
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.retention=30d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=50Gi
```

I keep 30 days of metrics data on a 50GB Longhorn volume. This is more than enough for trend analysis and capacity planning.

## Custom Exporters

Beyond the standard exporters, I run several custom ones:

### GitHub Exporter
Exports repository metrics: stars, forks, open issues, workflow run counts and durations. The Grafana dashboard shows CI/CD activity patterns across all repositories.

### Proxmox Hardware Exporter
Each Proxmox host runs lm-sensors feeding into node-exporter's textfile collector. This provides:
- CPU package and core temperatures
- Fan speeds (when the fan spins up)
- Chipset temperatures

### Seedbox Exporter
Custom Python exporter that scrapes seedbox statistics:
- Active transfer count
- Upload/download throughput
- Disk usage
- Ratio statistics

### NAS Exporter
Exposes TrueNAS metrics:
- Pool health status
- Disk SMART data
- ZFS ARC hit rate
- Network throughput per interface

### Exportarr (Radarr/Sonarr)
Sidecar containers that expose *arr application metrics:
- Queue length
- Download completion rate
- Library size
- Calendar upcoming entries

## ServiceMonitors

Every application in the cluster that exposes a `/metrics` endpoint gets a ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cardboard
  namespace: cardboard
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: cardboard
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
```

The `release: kube-prometheus-stack` label is critical — the Prometheus operator uses label selectors to discover ServiceMonitors, and by default it only picks up monitors matching the Helm release name.

## Loki Log Aggregation

Prometheus handles metrics. For logs, I use Loki + Promtail:

- **Promtail** runs as a DaemonSet on every node, tailing container logs via the kubelet API
- **Loki** indexes log labels (namespace, pod, container) and stores log chunks on the Longhorn volume
- **Grafana** provides a unified view — click from a metric anomaly directly to the relevant pod logs

This is particularly useful for debugging CronJob failures. Instead of running `kubectl logs` on ephemeral Job pods (which may have already been cleaned up), I query Loki for the logs persisted during the job run.

## Dashboard Gallery

I have built Grafana dashboards for every layer of the stack:

### Cluster Overview
- Node count, pod count, namespace count
- CPU/memory/disk utilization per node
- Pod restart counts (top 10)
- Network I/O per node

### Proxmox Watchdog
- Power cycle events (timeline)
- Proxmox host availability
- API response latency per host
- Temperature trends per host (4-across layout for 4 nodes)

### Application Dashboards
Each application has its own dashboard:
- **Cardboard**: Price scrape success rate, database size, query latency
- **Trade Bot**: Trade execution count, Bedrock token usage, portfolio value
- **Media Stack**: Library growth, transcode queue, disk usage trending
- **Alert Responder**: Alerts analyzed, remediation suggestions, response latency

### CI/CD Dashboard
- Workflow run duration by repository
- Runner pod utilization
- Build success/failure rate
- Queue wait time

## Alert Tuning

The default kube-prometheus-stack alerts are noisy. I spent time today tuning them:

### Removed: PveNodeHighMemory
As documented in the production failures post, Proxmox hosts show high memory usage due to ZFS ARC cache. This is normal and not actionable. Replaced with `PveNodeHighSwap`:

```yaml
- alert: PveNodeHighSwap
  expr: (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) / node_memory_SwapTotal_bytes > 0.5
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "High swap usage on {{ $labels.instance }}"
```

### Added: Media Pipeline Alerts
```yaml
- alert: RcloneSyncFailed
  expr: time() - rclone_last_sync_success_timestamp > 7200
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "rclone sync has not succeeded in 2+ hours"

- alert: RadarrQueueStuck
  expr: radarr_queue_total > 10
  for: 30m
  labels:
    severity: warning
  annotations:
    summary: "Radarr queue has 10+ items for 30+ minutes"
```

### Added: Backup Monitoring
```yaml
- alert: LonghornBackupFailed
  expr: longhorn_backup_last_completed_timestamp < (time() - 86400)
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "Longhorn backup has not completed in 24+ hours"
```

## Performance Benchmarks

Today I also ran comprehensive benchmarks to establish baseline performance numbers:

### CPU (sysbench)
```
Multi-thread (12 threads): 10,864 events/sec
Single-thread:              1,293 events/sec
```

### Memory (sysbench)
```
Sequential read:  16,114 MiB/sec
Sequential write: 15,892 MiB/sec
```

### Disk I/O (fio on Longhorn volume)
```
Random Write IOPS: 783K
Random Read IOPS:  414K
Sequential Write:  1.2 GB/s
Sequential Read:   890 MB/s
```

### Network (iperf3 between nodes)
```
1GbE throughput: 938 Mbps
```

These numbers serve as baselines. If future benchmarks show degradation, it indicates a configuration change or hardware issue.

## CI/CD Fixes

While reviewing the monitoring data, I noticed some CI/CD issues:

### Recreate Strategy
Trade Bot and Cardboard were using `RollingUpdate` deployment strategy, which caused brief periods where both old and new pods ran simultaneously. For applications with external session state (like Robinhood API sessions), this caused conflicts. Switched both to `Recreate`:

```yaml
spec:
  strategy:
    type: Recreate
```

### Rollout Timeouts
The default rollout timeout of 120 seconds was not enough for the Alert Responder and Media Controller, which have slow startup (fetching ML models and media metadata). Increased to 300 seconds.

## Lessons Learned

1. **Default Prometheus alerts need tuning for homelab.** Enterprise-oriented thresholds generate too much noise in a homelab context. Tune aggressively.
2. **Loki is essential for CronJob debugging.** Ephemeral workloads like Jobs and CronJobs may be cleaned up before you can read their logs. Loki preserves them.
3. **ServiceMonitor labels must match** the Prometheus operator's selector. The `release: kube-prometheus-stack` label is easy to forget.
4. **Benchmark early, benchmark often.** Establishing baseline performance numbers lets you detect degradation before users notice.
5. **Recreate strategy is safer** for applications with external session state. Rolling updates can cause session conflicts.

The monitoring stack now covers every layer: hardware, hypervisor, Kubernetes, and applications. When something goes wrong, I can see it in Grafana before the alert fires.
