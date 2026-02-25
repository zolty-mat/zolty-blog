---
title: "When Monitoring Goes Blind: A Longhorn Storage Corruption Incident"
date: 2026-02-25T20:00:00-06:00
draft: false
author: "zolty"
description: "How a new cluster node triggered Longhorn replica I/O errors that silently corrupted Prometheus WAL and Loki TSDB files, leaving Grafana showing No data for 26 hours."
tags: ["kubernetes", "longhorn", "prometheus", "loki", "debugging", "homelab", "storage", "k3s"]
categories: ["Operations"]
cover:
  image: "/images/covers/operations.svg"
  alt: "Monitoring goes blind — Longhorn storage corruption incident report"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Grafana went completely dark for about 26 hours on my home k3s cluster. Two things broke simultaneously: Loki entered CrashLoopBackOff, and Prometheus silently stopped ingesting metrics — its pods showed as healthy and 2/2 Running the whole time. The actual cause was Longhorn's auto-balancer migrating replicas onto a freshly-added cluster node (`k3s-agent-4`) that had unstable storage during its first 48 hours. The replica I/O errors propagated directly into the workloads, corrupting mid-write files: a Prometheus WAL segment and a Loki TSDB index file. Both required offline surgery via a busybox pod to delete the corrupted files before the services could recover.

---

## The Symptom

I opened Grafana and found a dashboard in an odd split-brain state. Two panels showed "No data" — *Scrape Targets Up* and *Running Pods* — while two others showed real numbers — *Scrape Targets Down = 0* and *Critical Alerts = 0*.

That asymmetry was the first clue. If Prometheus were completely down, all four panels would fail. Instead, the panels showing zeroes were queries like `count(ALERTS{...})` and `count(up{...} == 0)` — both of which truthfully return zero when nothing is being scraped. The panels that failed were `count(up{...} == 1)` and `count(kube_pod_info)` — both require recent data to return anything meaningful.

Prometheus wasn't failing. It was returning accurate answers to a 26-hour old dataset.

---

## Investigation Part 1: Loki was the red herring

The first thing that jumped out in `kubectl get pods -n monitoring` was Loki:

```
loki-0   1/2   Error   69   3d
```

69 restarts. The logs were clear:

```
level=error ts=... caller=... msg="error initialising module: store"
...
input/output error: /var/loki/chunks/index/index_20505/fake/...c313bc56.tsdb.gz
```

A corrupted TSDB index file. The fix was straightforward: scale the StatefulSet down, delete the bad index directory via a busybox pod mounted to the PVC, then scale back up.

```bash
kubectl scale statefulset loki -n monitoring --replicas=0

kubectl run loki-fix --image=busybox --restart=Never -n monitoring \
  --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"storage-loki-0"}}],"containers":[{"name":"f","image":"busybox","command":["sh","-c","rm -rf /var/loki/chunks/index/index_20505 /var/loki/tsdb-shipper-cache/index_20505; echo done"],"volumeMounts":[{"name":"d","mountPath":"/var/loki"}]}],"restartPolicy":"Never"}}'

kubectl scale statefulset loki -n monitoring --replicas=1
```

Loki came back 2/2 Running, zero restarts. Grafana still showed "No data" on the metrics panels. Loki wasn't the real problem.

---

## Investigation Part 2: The silent Prometheus failure

Prometheus looked fine on the surface. `kubectl get pods -n monitoring` showed:

```
prometheus-prometheus-kube-prometheus-prometheus-0   2/2   Running   0   3d
```

However, checking the TSDB status via the Prometheus HTTP API told a different story:

```bash
kubectl port-forward -n monitoring prometheus-prometheus-kube-prometheus-prometheus-0 9090:9090
curl -s http://localhost:9090/api/v1/status/tsdb | jq .data.headStats
```

```json
{
  "numSeries": 401623,
  "chunkCount": 3982194,
  "minTime": 1739980800000,
  "maxTime": 1740362700000
}
```

`maxTime` was `1740362700000` — which converts to **February 24, 03:45 UTC**. I was looking at this on February 25, around 06:00 UTC. The dataset was over 26 hours stale.

Prometheus was alive, running queries, returning results — just from a dataset frozen in time. No error was surfaced anywhere obvious. The pod was healthy, the operator was healthy, the service was healthy.

The actual error was buried in the Prometheus container logs:

```
ts=... level=error caller=db.go:... msg="write to WAL" err="log samples: write /prometheus/wal/00000042: input/output error"
```

Segment `00000042` was corrupted. Every scrape cycle failed to write. Since WAL writes failed, no new data was being committed to the head block. Prometheus kept returning results from the last successfully persisted data — 26 hours ago.

The truly painful part: `rm` of the corrupted file failed even from inside an `kubectl exec` session:

```
rm: /prometheus/wal/00000042: Input/output error
```

The only path forward was to take Prometheus completely offline.

---

## The Fix

The key insight for the Prometheus fix was **operator-first scaling**. If you scale the StatefulSet down while the Prometheus Operator is still running, it immediately scales it back up. You have to knock out the operator first.

```bash
# Step 1: Kill the operator
kubectl scale deployment prometheus-kube-prometheus-operator -n monitoring --replicas=0

# Step 2: Kill the StatefulSet
kubectl scale statefulset prometheus-prometheus-kube-prometheus-prometheus -n monitoring --replicas=0
```

Then the PVC mount path gotcha hit me. The Prometheus logs reference `/prometheus/wal/...` — but inside the actual pod, the PVC is mounted at `/data/`, with the actual data at `/data/prometheus-db/`. The WAL lives at `/data/prometheus-db/wal/`. This is a kube-prometheus-stack convention, not Prometheus default behavior.

```bash
PVC="prometheus-prometheus-kube-prometheus-prometheus-db-prometheus-prometheus-kube-prometheus-prometheus-0"

kubectl run prom-wal-fix --image=busybox --restart=Never -n monitoring \
  --overrides="{\"spec\":{\"volumes\":[{\"name\":\"d\",\"persistentVolumeClaim\":{\"claimName\":\"$PVC\"}}],\"containers\":[{\"name\":\"f\",\"image\":\"busybox\",\"command\":[\"sh\",\"-c\",\"ls /data/prometheus-db/wal/; rm -f /data/prometheus-db/wal/00000040 /data/prometheus-db/wal/00000041 /data/prometheus-db/wal/00000042; echo done\"],\"volumeMounts\":[{\"name\":\"d\",\"mountPath\":\"/data\"}]}],\"restartPolicy\":\"Never\"}}"

kubectl wait pod/prom-wal-fix -n monitoring \
  --for=condition=Succeeded --timeout=60s

kubectl logs prom-wal-fix -n monitoring
kubectl delete pod prom-wal-fix -n monitoring
```

I deleted the three most recent WAL segments (00000040, 00000041, 00000042) and kept the existing checkpoint intact. A checkpoint represents a complete consistent snapshot of the head block, so keeping it lets Prometheus replay from a known good state.

Scale back up in reverse order — StatefulSet first, then operator:

```bash
kubectl scale statefulset prometheus-prometheus-kube-prometheus-prometheus -n monitoring --replicas=1
kubectl scale deployment prometheus-kube-prometheus-operator -n monitoring --replicas=1
```

After about 30 seconds, `count(up{job!=""} == 1)` returned 90. `count(kube_pod_info)` returned 196. Grafana came back to life.

---

## Root Cause: A New Node, Automatic Rebalancing, and the First 48 Hours

The *how* was clear. The *why* took some digging through Longhorn events:

```bash
kubectl get events -n longhorn-system \
  --sort-by=.lastTimestamp \
  --field-selector reason=FailedRebuilding | tail -20
```

Both the Prometheus PVC (30Gi, `pvc-c6c1475a`) and the Loki PVC (10Gi) had ongoing `FailedRebuilding` events. The rebuilding failures were centered on replicas at a specific instance-manager IP. Cross-referencing:

```bash
kubectl get nodes -o wide
```

The IP traced to `k3s-agent-4` — my newest node, added on February 21. By February 23 it was Ready. Longhorn's auto-balance (set to `best-effort`) detected an under-replicated distribution across the now-7-node cluster and migrated replicas onto the new node. This all happened automatically, in the background, with no alerts.

The new node had storage instability during its first 48 hours — likely related to kernel setup, disk scheduler tuning, or just settling-in behavior. The Longhorn instance-manager on that node was cycling through liveness probe failures. When an instance-manager restarts, its in-flight replicas momentarily go ERR. An ERR replica propagates I/O errors directly to the workload during any active write. If that write is mid-WAL or mid-TSDB-index, the file is left permanently corrupted.

The two most write-heavy volumes in the monitoring namespace — Prometheus (continuous WAL appends) and Loki (continuous chunk writes) — both had replicas on the unstable node. Both got hit simultaneously. That's why the whole monitoring stack appeared to fail at once.

---

## Lessons Learned

**1. A running pod is not the same as a healthy pod.**
Prometheus was 2/2 Running with no restarts while silently serving 26-hour-old data. The WAL write failure was logged at ERROR level but nothing surfaced to the operator level. If there's no alert on `prometheus_tsdb_head_max_time_seconds`, you have a blind spot.

**2. Check TSDB status when Grafana shows "No data."**
Before assuming network issues, service failures, or datasource misconfiguration: `kubectl port-forward ... 9090 && curl .../api/v1/status/tsdb | jq .data.headStats`. The `maxTime` field tells you immediately whether Prometheus is ingesting fresh data.

**3. Longhorn replica ERR events are fire, not smoke.**
A `FailedRebuilding` event in Longhorn isn't just an availability warning — it means the degraded replica was in ERR state, and I/O errors propagated to the workload. Any file that was being written at that moment is potentially corrupted. Monitor Longhorn events after any node change, storage disruption, or UPS event.

**4. New nodes need a quarantine period.**
Longhorn's auto-balance will migrate replicas onto a new node within 24h. If the node has any storage instability during that window — and new nodes often do — your existing volumes are at risk. Protocol: when adding a new node, temporarily disable Longhorn scheduling on it, let it run for 24-48h, verify storage health, then re-enable.

```bash
# Disable scheduling on new node until it's proven stable
kubectl patch nodes.longhorn.io k3s-agent-4 -n longhorn-system \
  --type=merge -p '{"spec":{"allowScheduling":false}}'

# Re-enable after 48h of healthy operation
kubectl patch nodes.longhorn.io k3s-agent-4 -n longhorn-system \
  --type=merge -p '{"spec":{"allowScheduling":true}}'
```

**5. Scale the operator before the StatefulSet.**
This is a Kubernetes operator pattern in general: if a controller owns the StatefulSet, the controller will fight you if you scale down the StatefulSet while the controller is still running. Always kill the operator first.

**6. The PVC mount path is not what the logs say.**
kube-prometheus-stack mounts the Prometheus PVC at `/data/`, so the actual WAL path is `/data/prometheus-db/wal/` — not `/prometheus/wal/` as shown in the application logs. This is a kube-prometheus-stack deployment convention. The exec busybox trick only works if you know where to look.

---

## Recommended Alerts to Add

Based on this incident, I have three Prometheus alert rules in mind that would have caught both issues immediately:

**Alert 1 — Prometheus data freshness:**
```yaml
- alert: PrometheusDataStaleness
  expr: (time() - prometheus_tsdb_head_max_time_seconds / 1000) > 600
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Prometheus not ingesting new data (>10 min stale)"
```

**Alert 2 — Longhorn volume degraded:**
```yaml
- alert: LonghornVolumeRobustness
  expr: longhorn_volume_robustness > 0
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "Longhorn volume {{ $labels.volume }} is not Healthy"
```

**Alert 3 — Loki ingestion dropped:**
```yaml
- alert: LokiIngestionDown
  expr: rate(loki_ingester_chunks_flushed_total[5m]) == 0
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Loki not flushing chunks — possible crash or I/O issue"
```

The first two would have fired within minutes of the corruption event. The third might have given a few minutes of warning before Loki completely crashed.

---

## Final State

After both fixes:
- Loki: 2/2 Running, 0 restarts
- Prometheus: 2/2 Running, active ingestion confirmed (`maxTime` within 60s of current time)
- Grafana: 90 scrape targets up, 196 pods visible, all panels populated
- `k3s-agent-4` Longhorn scheduling disabled until further validation

The cluster is healthy. The documentation and alert rules are next.
