---
title: "Top 10 Production Failures and What I Learned"
date: 2026-02-15T19:30:00-06:00
draft: false
author: "zolty"
description: "One week into running a homelab k3s cluster in production, here are the top 10 failures I have encountered and the lessons each one taught me about Kubernetes operations."
tags: ["kubernetes", "lessons-learned", "debugging", "production", "homelab"]
categories: ["Operations"]
cover:
  image: ""
  alt: "Production failures and lessons"
  hidden: true
ShowToc: true
TocOpen: false
---

## TL;DR

After one week of operating this cluster with real workloads, I have accumulated a healthy list of production failures. Each one taught me something about Kubernetes, infrastructure, or my own assumptions. Here are the top 10, ranked by how much time they cost to investigate and fix.

## 1. The Longhorn S3 Backup Credential Rotation

**Impact**: All Longhorn backups silently failed for 12 hours.

**What happened**: I rotated the IAM credentials used for S3 backups and updated the Kubernetes secret. But Longhorn caches credentials at startup — it does not re-read the secret dynamically. All backup jobs continued using the stale credentials and failing silently.

**Fix**: After updating the secret, restart the Longhorn manager pods to force credential reload:

```bash
kubectl rollout restart deployment longhorn-manager -n longhorn-system
```

**Lesson**: Credential rotation in Kubernetes is not automatic for most controllers. Always verify backup functionality after rotating secrets, and build monitoring that alerts on backup failures — not just backup age.

## 2. ARC Runner Labels Replace Defaults

**Impact**: All CI/CD workflows stuck in "Queued" state for 45 minutes.

**What happened**: I modified the ARC RunnerDeployment to add custom labels. The `labels` field in ARC completely replaces the default label set. My workflows required `self-hosted`, which was no longer present on the runners.

**Fix**: Explicitly include `self-hosted` in the label list.

**Lesson**: Never assume additive behavior for label/tag configurations. Read the API docs, and always test label changes with a canary workflow.

## 3. RBAC Escalate/Bind Verbs

**Impact**: Deployment pipeline broken, 1 hour to debug.

**What happened**: A workflow created a RoleBinding granting a service account permissions. Kubernetes rejected it because the runner's service account did not have `escalate` and `bind` verbs on the `rolebindings` resource.

**Fix**: Add `escalate` and `bind` to the runner's ClusterRole.

**Lesson**: Kubernetes RBAC has a safety mechanism: you cannot grant permissions you do not have. The `escalate` verb allows creating bindings that exceed your own permissions. The error message is a generic "forbidden" that does not mention this requirement.

## 4. CoreDNS Single Replica

**Impact**: Cluster-wide DNS outage lasting 3 minutes.

**What happened**: CoreDNS was running a single replica on one specific node. That node was drained for maintenance, killing DNS resolution for the entire cluster. Every pod that tried to resolve a service name — including the system pods — failed.

**Fix**: Scale CoreDNS to 2+ replicas with pod anti-affinity:

```bash
kubectl -n kube-system patch deployment coredns \
  --type=merge \
  -p '{"spec":{"replicas":2}}'
```

**Lesson**: DNS is the single most critical service in a Kubernetes cluster. Always run multiple replicas spread across nodes. This is a deployment-ready checklist item.

## 5. The etcd Snapshot During VLAN Migration

**Impact**: etcd quorum lost, 20-minute recovery.

**What happened**: During a network VLAN migration, etcd members lost connectivity to each other when their IPs changed. With quorum lost, the API server became read-only.

**Recovery**:
```bash
# On the surviving server node
sudo k3s server --cluster-reset

# After reset, rejoin other servers
# On server-2 and server-3
sudo systemctl restart k3s
```

**Lesson**: Never change network configuration on multiple control plane nodes simultaneously. Migrate one node at a time, verify quorum after each, and have the `--cluster-reset` procedure documented and tested.

## 6. PVE Memory Alert Storm

**Impact**: 200+ Slack alerts in one hour, total alert fatigue.

**What happened**: The Proxmox memory alert was configured with a threshold based on total memory usage. Proxmox hosts use significant memory for ZFS ARC cache, which inflates the "used memory" metric even though the cache is reclaimable. Every ZFS operation triggered memory alerts.

**Fix**: Replaced `PveNodeHighMemory` with `PveNodeHighSwap`. Swap usage is a much better indicator of actual memory pressure than total memory consumption.

**Lesson**: Not all memory is created equal. Cached memory that can be reclaimed under pressure is not a problem. Alert on swap usage, not total memory usage, especially on systems with aggressive caching (ZFS, Linux page cache).

## 7. arm64 Scheduling Roulette

**Impact**: Recurring pod CrashLoopBackOff on arm64 node.

**What happened**: New deployments without explicit `nodeSelector` occasionally got scheduled on the arm64 node (Lima). The amd64 container image would crash immediately with an exec format error.

**Fix**: Added `nodeSelector: kubernetes.io/arch: amd64` to every deployment.

**Lesson**: In mixed-architecture clusters, the default scheduler does not consider image architecture compatibility. Every workload needs an explicit constraint. Make it part of your deployment template.

## 8. Helm --wait Hanging

**Impact**: CI pipeline timeout after 10 minutes.

**What happened**: `helm install --wait` needs to watch ReplicaSets and Events to determine if a deployment succeeded. The ARC runner's RBAC did not include `watch` verbs for these resources, so Helm sat there indefinitely.

**Fix**: Add `watch` verb for replicasets and events in the runner's ClusterRole.

**Lesson**: `helm --wait` is deceptively simple. Under the hood, it sets up Kubernetes watches on multiple resource types. Your deployer's RBAC needs to support all of them.

## 9. Stale Longhorn Node

**Impact**: Volume scheduling failures for 2 hours.

**What happened**: A k3s agent node was decommissioned but its entry persisted in Longhorn's node list. New volume replicas attempted to schedule on the non-existent node and failed.

**Fix**: Remove the stale node from Longhorn:

```bash
kubectl delete node <stale-node> -n longhorn-system
```

And remove the corresponding k3s node:
```bash
kubectl delete node <stale-node>
```

**Lesson**: Kubernetes node cleanup is not automatic. When decommissioning a node, explicitly remove it from both k3s and Longhorn. Add it to your decommission checklist.

## 10. Wiki API Key Published

**Impact**: Security incident — API key exposed in a commit.

**What happened**: While setting up the GitHub Wiki API integration, an API key was committed in a configuration file that was not in `.gitignore`.

**Fix**: Immediately revoked the key, generated a new one, and added the config file to `.gitignore`. Also ran `git filter-branch` to remove the key from Git history.

**Lesson**: Secrets in Git happen to everyone eventually. Defense in depth:
1. Add sensitive file patterns to `.gitignore` proactively
2. Use pre-commit hooks to scan for secrets (e.g., `detect-secrets`)
3. Store secrets in SOPS-encrypted files or Kubernetes secrets
4. Have a key rotation procedure ready

## Summary: The Operational Maturity Checklist

Based on these failures, here is my checklist for homelab Kubernetes operational readiness:

- [ ] CoreDNS: 2+ replicas with anti-affinity
- [ ] Backup verification: Automated testing of backup/restore
- [ ] Credential rotation: Documented procedure with post-rotation verification
- [ ] RBAC: Audited for escalate/bind/watch verbs
- [ ] Node selectors: All workloads constrained to correct architecture
- [ ] Alert tuning: No false-positive-heavy alerts
- [ ] Decommission procedure: Documented node removal steps
- [ ] Secret scanning: Pre-commit hooks in place
- [ ] etcd recovery: `--cluster-reset` procedure tested
- [ ] Monitoring meta-alerts: Alert on monitoring failures themselves

One week in, and the cluster is more resilient for every failure it has experienced. That is the real value of running your own infrastructure — when things break, you learn exactly how they work.
