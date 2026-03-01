---
title: "Upgrading k3s Across Five Minor Versions: v1.29 to v1.34 on a Homelab Cluster"
date: 2026-02-22T23:00:00-06:00
draft: false
author: "zolty"
description: "Rolling k3s upgrade from v1.29.0 to v1.34.4 across 8 nodes with interleaved Longhorn upgrades, broken SSH, and unexpected Traefik pinning."
tags: ["k3s", "kubernetes", "upgrade", "longhorn", "traefik", "homelab", "proxmox", "lima"]
categories: ["Operations"]
cover:
  image: "/images/covers/operations.svg"
  alt: "k3s cluster upgrade from v1.29 to v1.34"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Upgraded a production k3s cluster from v1.29.0+k3s1 to v1.34.4+k3s1 across 8 nodes — 3 control plane servers, 4 amd64 worker agents, and 1 arm64 Lima VM agent. The upgrade stepped through every minor version (v1.29 → v1.30 → v1.31 → v1.32 → v1.33 → v1.34) with etcd snapshots between each step. Longhorn was upgraded from v1.6.0 to v1.8.2 in two stages (v1.7.3 as an intermediate step). SSH was broken to all cluster nodes, so the entire upgrade was done via Proxmox QEMU Guest Agent (`qm guest exec`) and Lima CLI (`limactl shell`). Discovered that k3s intentionally pins Traefik to v2.11.24 even when bundling Helm chart v27 — Traefik v3 migration is a separate effort.

## Why Upgrade

The cluster had been running k3s v1.29.0+k3s1 since initial deployment. Five minor versions behind meant accumulating security patches, API deprecations, and compatibility gaps with newer tooling. Longhorn v1.6.0 was also aging — newer versions had SPDK improvements, better replica scheduling, and critical bug fixes.

The specific motivator was Kubernetes API deprecations. Several APIs removed in v1.32+ would eventually break workloads, and falling further behind makes the upgrade path riskier. Better to do it now with a controlled rollout than scramble later when something forces a jump.

## The Upgrade Strategy

Skipping minor versions of k3s is not supported and risks etcd schema incompatibilities. The plan was straightforward:

1. Step through each minor version sequentially
2. Take an etcd snapshot before each step
3. Upgrade Longhorn at compatibility boundaries
4. Update all version pins in IaC after completion

The upgrade order within each version step follows the k3s documentation: servers first (one at a time), then agents (one at a time). Each node gets drained, upgraded, restarted, verified Ready, and uncordoned before moving to the next.

### The Node Inventory

| Node | Role | Architecture | Location | Upgrade Method |
|---|---|---|---|---|
| k3s-server-1 | control-plane, etcd | amd64 | VM 110 @ pve1 | `qm guest exec` |
| k3s-server-2 | control-plane, etcd | amd64 | VM 111 @ pve2 | `qm guest exec` |
| k3s-server-3 | control-plane, etcd | amd64 | VM 112 @ pve3 | `qm guest exec` |
| k3s-agent-1 | worker | amd64 | VM 120 @ pve1 | `qm guest exec` |
| k3s-agent-2 | worker | amd64 | VM 121 @ pve2 | `qm guest exec` |
| k3s-agent-3 | worker | amd64 | VM 122 @ pve3 | `qm guest exec` |
| k3s-agent-4 | worker (GPU) | amd64 | VM 123 @ pve4 | `qm guest exec` |
| lima-k3s-agent | worker | arm64 | Mac Mini Lima VM | `limactl shell` |

## Pre-Flight

Before touching any node, three things had to be confirmed:

**1. Database backups.** Ten PostgreSQL databases across namespaces (cardboard, trade-bot, wiki, grafana, auto-brand, etc.) were backed up via `pg_dump`. Losing a database during an upgrade is the kind of mistake you only make once.

**2. Etcd snapshot.** A baseline etcd snapshot named `pre-upgrade-20260222-2149` was taken on server-1. This is the rollback point if the entire upgrade goes sideways.

**3. Longhorn health.** All Longhorn volumes verified healthy — 32 volumes, 32 healthy, 0 degraded. An upgrade with unhealthy storage is a recipe for data loss.

## SSH Was Broken

The first surprise: SSH authentication to every cluster node was broken. Neither the default key (`~/.ssh/id_rsa`) nor the k3s-specific key (`~/.ssh/k3s_dev`) authenticated. Every attempt returned `Permission denied (publickey)`.

This meant the Ansible upgrade playbook (`ansible/playbooks/upgrade-k3s.yml`) was unusable. Three options:

1. Fix SSH — debug key authentication across 8 nodes
2. Use `kubectl debug node/` — run privileged containers on each node
3. Use Proxmox QEMU Guest Agent — execute commands directly on VMs

Option 2 was a dead end. Running `systemctl stop k3s-agent` inside a debug container kills containerd, which kills the container running the command. The debug pod destroys itself.

Option 3 worked. The Proxmox QEMU Guest Agent (`qemu-guest-agent`) was already installed on all VMs. The `qm guest exec` command on the Proxmox host runs arbitrary commands inside the VM without needing SSH. For the Lima node on the Mac Mini, `limactl shell` does the same thing.

### The Proxmox Upgrade Pattern

For each Proxmox VM node, the sequence was:

```bash
# 1. Drain the node (from local machine with kubectl)
kubectl cordon k3s-agent-1
kubectl drain k3s-agent-1 --ignore-daemonsets \
  --delete-emptydir-data --force \
  --timeout=90s --disable-eviction

# 2. Stop k3s (via Proxmox host)
ssh root@192.168.1.105 \
  "qm guest exec 120 -- systemctl stop k3s-agent"

# 3. Install new version (via Proxmox host)
ssh root@192.168.1.105 \
  "qm guest exec 120 --timeout 120 -- bash -c \
  'curl -sfL https://get.k3s.io | \
   INSTALL_K3S_VERSION=v1.30.14+k3s2 \
   INSTALL_K3S_SKIP_START=true sh -s - agent'"

# 4. Restore the env file (installer wipes it!)
ssh root@192.168.1.105 \
  "qm guest exec 120 -- bash -c \
  'printf \"K3S_TOKEN=<token>\nK3S_URL=https://192.168.20.20:6443\n\" \
  > /etc/systemd/system/k3s-agent.service.env'"

# 5. Start the agent
ssh root@192.168.1.105 \
  "qm guest exec 120 -- systemctl daemon-reload"
ssh root@192.168.1.105 \
  "qm guest exec 120 -- systemctl start k3s-agent"

# 6. Verify and uncordon
sleep 15
kubectl get node k3s-agent-1
kubectl uncordon k3s-agent-1
```

This pattern was repeated 40 times — 8 nodes × 5 version steps.

## The Installer Wipes the Env File

The most dangerous gotcha in the entire upgrade: **the k3s installer always creates a fresh, empty env file at `/etc/systemd/system/k3s-agent.service.env`**, even when using `INSTALL_K3S_SKIP_START=true`.

For agent nodes, this file contains `K3S_TOKEN` and `K3S_URL` — the two things the agent needs to join the cluster. Without them, `systemctl start k3s-agent` starts the binary but it has no idea which cluster to join. The agent sits there doing nothing while `kubectl get nodes` shows it as `NotReady` forever.

Server nodes are unaffected because their join configuration comes from command-line arguments in the systemd service file (`--cluster-init`, `--token`, etc.), not the env file.

The fix is mechanical: after every `curl | sh` install, immediately restore the env file before starting the service. This has to happen on every agent, every version step. There is no flag to skip the env file creation.

{{< ad >}}

## Longhorn Required Two-Stage Upgrade

Longhorn v1.6.0 could not jump directly to v1.8.2. The Longhorn upgrade documentation specifies that you can only skip one minor version at most, meaning v1.6 → v1.7 → v1.8.

The first stage (v1.6 → v1.7.3) was done after the k3s v1.29 → v1.30 step. The second stage (v1.7.3 → v1.8.2) was done after k3s v1.31 → v1.32. Both upgrades were applied via `kubectl apply -f` from the Longhorn GitHub release manifests:

```bash
kubectl apply -f \
  https://raw.githubusercontent.com/longhorn/longhorn/v1.7.3/deploy/longhorn.yaml
```

Each Longhorn upgrade took about 10 minutes for all pods to cycle. The v1.8.2 upgrade brought the pod count from 32 to 70 — new components for snapshot management, CSI improvements, and additional instance manager pods.

One quirk: **Longhorn v1.7.4 does not exist.** The GitHub release page returns 404. v1.7.3 was the latest available patch for the v1.7.x line. Always verify release URLs before running `kubectl apply`.

## Drain Fights with Longhorn PDBs

Every single node drain encountered the same issue: Longhorn PodDisruptionBudgets block eviction of instance-manager and CSI pods. The standard `kubectl drain` command hangs until timeout because it respects PDBs by default.

The workaround is `--disable-eviction`, which bypasses PDB checks and directly deletes pods. This is safe for Longhorn because instance managers are DaemonSet-managed and will immediately reschedule.

Even with `--disable-eviction`, StatefulSet pods like `loki-0` and `prometheus-prometheus-kube-prometheus-prometheus-0` consistently timed out on drain. These thick monitoring pods take longer than 90 seconds to gracefully terminate. The solution every time was `kubectl delete pod --force --grace-period=0` after the drain timed out. They reschedule on another node within seconds.

## Traefik Is Still on v2

This was the biggest surprise. Starting with k3s v1.30, k3s bundles Traefik Helm chart v27 (which is the Traefik v3 chart). But k3s does not actually deploy Traefik v3.

Deep in the k3s default manifest at `/var/lib/rancher/k3s/server/manifests/traefik.yaml`, the Helm chart values explicitly pin the image tag:

```yaml
valuesContent: |-
  image:
    tag: "2.11.24"
```

This means k3s ships the Traefik v3 chart but forces the Traefik v2 image. The chart is backwards-compatible, so it works fine. But if you expected the k3s upgrade to automatically migrate you to Traefik v3 — it does not.

Traefik v3 migration is a separate project that requires:

1. Overriding the image tag via HelmChartConfig
2. Updating the CLI flags (e.g., `--serversTransport.insecureSkipVerify` → `--serversTransport.tls.insecureSkipVerify`)
3. Testing every IngressRoute for v3 compatibility
4. Dealing with the `traefik.containo.us` → `traefik.io` API group migration (already partially done — the old API group is removed in newer Traefik CRD versions)

For now, Traefik v2.11.24 continues to work. The Traefik HelmChartConfig template was updated with the v3-compatible CLI flag as forward preparation.

## What Broke After the Upgrade

### Wiki.js Lost Its IngressRoute

Wiki.js was the one service still using the old `traefik.containo.us/v1alpha1` API group for its IngressRoute. After the upgrade, this CRD was removed — the cluster now only supports `traefik.io/v1alpha1`. The wiki pod runs fine, but it has no IngressRoute, so it is unreachable via the browser. The fix is to recreate the IngressRoute with the new API group.

### Wiki.js Database Connection Errors

The wiki pod logs show intermittent `ECONNREFUSED 10.43.98.54:5432` errors. The postgres pod in the wiki namespace is running, but the service connection is flaky. This may be related to the node shuffling during the upgrade — the postgres pod and wiki pod may have landed on different nodes than before, and a NetworkPolicy or DNS issue could be causing intermittent failures. The pod has restarted 10 times in 26 hours.

### Everything Else Survived

Dashboard, Grafana, Longhorn UI, Cardboard, Trade Bot — all returned HTTP 200 after the upgrade. The media stack (Jellyfin, Radarr, Sonarr, Prowlarr, Bazarr, Tdarr) continued running. Prometheus kept scraping. CI/CD runners stayed healthy. The upgrade did not cause any data loss or persistent outages beyond the wiki.

## Version Pin Cleanup

After completing all 8 nodes at v1.34.4+k3s1, there were 33 files across the repository with stale version references. These fell into four categories:

| Category | Count | Examples |
|---|---|---|
| IaC (functional) | 9 | `ansible/group_vars/all.yml`, `terraform/variables.tf`, `lima/k3s-agent.yaml` |
| Documentation | 12 | `docs/platform-reference.md`, `BOOTSTRAP.md`, dashboard YAML |
| CI/CD workflows | 7 | `deploy-k8s-apps.yml` (kubectl version), `alert-responder.yml` |
| Wiki/diagram scripts | 5 | `populate-wiki.py`, `upload-wiki-diagrams.py` |

All 33 were updated — k3s pins to `v1.34.4+k3s1` and Longhorn pins to `v1.8.2`. The CI/CD kubectl downloads were bumped from `v1.29.0` to `v1.34.4` to match the cluster version.

## Etcd Snapshots Taken

Five etcd snapshots were taken throughout the upgrade, one before the start and one after each major stage:

| Snapshot | Timestamp | Cluster State |
|---|---|---|
| `pre-upgrade-20260222-2149` | Start | v1.29, Longhorn v1.6.0 |
| `post-v130-upgrade-20260222-2221` | After Phase 1 | v1.30, Longhorn v1.7.3 |
| `post-v131-upgrade-20260222-2246` | After Phase 4 | v1.31 |
| `post-v132-longhorn182-20260222-2306` | After Phase 5+6 | v1.32, Longhorn v1.8.2 |
| `post-v134-upgrade-final-20260222-2337` | End | v1.34, Longhorn v1.8.2 |

These live in `/var/lib/rancher/k3s/server/db/snapshots/` on each server node. If anything goes catastrophically wrong post-upgrade, any snapshot can restore the cluster to that exact state.

## Lessons Learned

**1. The k3s installer always overwrites the agent env file.** This is the most dangerous aspect of the upgrade. There is no flag to prevent it. You must restore `K3S_TOKEN` and `K3S_URL` after every agent install. Automating this requires keeping the token accessible — which in this case meant embedding it in the `qm guest exec` commands. For future upgrades, the Ansible playbook should handle this, but that requires fixing SSH first.

**2. Proxmox QEMU Guest Agent is a viable upgrade path when SSH is broken.** The `qm guest exec` command runs anything inside the VM, with full root access, and returns structured JSON with exit codes and stdout/stderr. It is slower and more verbose than SSH, but it works when nothing else does. This is a good emergency fallback to document.

**3. Longhorn PDBs fight drain every single time.** Using `--disable-eviction` is not a hack — it is the recommended approach for Longhorn-heavy clusters. The alternative is temporarily deleting the PDBs, which is riskier. Accept that monitoring StatefulSets will timeout on drain and plan for force-deletion.

**4. k3s does not migrate Traefik from v2 to v3.** This was the biggest expectation mismatch. The upgrade documentation does not mention this — you have to dig into the default manifest on the server node to discover the pinned image tag. Plan for Traefik v3 as a separate migration project.

**5. Step-through-each-minor-version is tedious but safe.** The full upgrade took about 2 hours for all 8 nodes across 5 version steps. No version step caused a cluster-level issue. The etcd snapshots between steps provided confidence to continue. There is no shortcut — do the boring thing.

**6. Version pins accumulate in surprising places.** Beyond the obvious IaC files, version references exist in dashboards, wiki scripts, CI/CD kubectl downloads, alert-responder embedded prompts, example inventory files, and documentation. A `grep -r` sweep after the upgrade is mandatory. In this case, 33 files needed updating.

## What Is Next

- **Fix SSH authentication** to all cluster nodes — the root cause is undiagnosed and the Ansible playbook cannot run without it
- **Migrate Wiki.js IngressRoute** from `traefik.containo.us/v1alpha1` to `traefik.io/v1alpha1` and investigate the database connection flakiness
- **Evaluate Traefik v3 migration** — audit all IngressRoutes, update CLI flags, override the image tag via HelmChartConfig
- **Fix the Ansible upgrade playbook** to handle env file restoration automatically after each agent install
- **Investigate moving to k3s system-upgrade-controller** for automated rolling upgrades instead of manual node-by-node procedures
