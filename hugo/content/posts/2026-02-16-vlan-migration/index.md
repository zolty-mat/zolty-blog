---
title: "VLAN Migration: Moving a Live Kubernetes Cluster Without Downtime"
date: 2026-02-16T22:00:00-06:00
draft: false
author: "zolty"
description: "How I migrated all k3s nodes, MetalLB pool, and load balancer IPs from a flat network to a dedicated Server VLAN — and the etcd recovery procedure I needed when things went wrong."
tags: ["networking", "vlan", "kubernetes", "etcd", "homelab"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "VLAN migration"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Today was the biggest infrastructure day yet. I migrated the entire k3s cluster from a flat network to a proper VLAN architecture: Server VLAN 20 for k3s nodes and services, Storage VLAN 30 for the NAS, and the existing default VLAN 1 for clients. This involved changing IPs on all VMs, updating MetalLB, reconfiguring Traefik, and recovering from an etcd quorum loss when I moved too many nodes at once. I also deployed the media stack (Jellyfin, Radarr, Sonarr, Prowlarr, Jellyseerr) and configured Intel iGPU passthrough infrastructure.

![Network switch mounted on the wooden rack shelf — the brains behind all the VLAN routing](network-switch.jpg)

## The Network Before

Everything was on a flat 192.168.1.0/24 network:

```
192.168.1.0/24 (VLAN 1 — Default)
├── Client devices
├── Proxmox hosts
├── k3s VMs
├── NAS
├── IoT devices
└── Everything else
```

This works but has problems:

- No traffic isolation between k3s workloads and client devices
- No way to set different firewall rules per traffic type
- Broadcast domain includes every device on the network
- Storage traffic competes with regular network traffic

## The Network After

```
VLAN 1 — Default (192.168.1.0/24)
├── Client devices
├── IoT devices
└── Management traffic

VLAN 20 — Server (192.168.20.0/24)
├── Proxmox hosts (.105-.108)
├── k3s servers (.20-.22)
├── k3s agents (.30-.33)
├── MetalLB pool (.200-.220)
└── Service load balancers

VLAN 30 — Storage (192.168.30.0/24)
├── NAS (TrueNAS)
├── Seedbox
└── Backup targets
```

## The Migration Plan

The migration needed to happen live — I did not want extended downtime. The plan:

1. Configure VLAN 20 and VLAN 30 on the switch
2. Set up inter-VLAN routing on the firewall
3. Create Proxmox bridge for VLAN 20 on each host
4. Migrate one k3s node at a time (IP change, verify, next)
5. Update MetalLB IP pool
6. Update DNS records
7. Migrate NAS to VLAN 30

{{< ad >}}

## What Actually Happened

Steps 1-3 went smoothly. Step 4 is where things got interesting.

### The etcd Disaster

I moved the first server node successfully — changed its IP in Terraform, applied, and the VM came up on the new network. The remaining two servers maintained etcd quorum.

Then I got impatient. Instead of migrating one node at a time, I migrated server-2 and server-3 simultaneously. When they both came up with new IPs, etcd could not form quorum — all three members had different advertised addresses than what the existing cluster state expected.

```
etcd: cluster ID mismatch
etcd: member not found
kube-apiserver: connection refused
```

The control plane was down. kubectl returned connection errors. The cluster was in a bad state.

### The Recovery

The k3s `--cluster-reset` flag saved me:

```bash
# On k3s-server-1 (the first migrated node, with most recent data)
sudo systemctl stop k3s
sudo k3s server --cluster-reset

# This reinitializes etcd as a single-node cluster
# After it starts, rejoin the other servers

# On k3s-server-2
sudo systemctl stop k3s
sudo rm -rf /var/lib/rancher/k3s/server/db
sudo systemctl start k3s

# On k3s-server-3
sudo systemctl stop k3s
sudo rm -rf /var/lib/rancher/k3s/server/db
sudo systemctl start k3s
```

Recovery took about 20 minutes. All application data survived — Longhorn volumes and PostgreSQL data are independent of etcd. The etcd state (Kubernetes API objects) was rebuilt from the reset node.

### The Right Way

For future reference, the correct migration sequence for an HA k3s cluster:

1. Migrate **one server** node at a time
2. After each migration, verify etcd quorum: `etcdctl member list`
3. Do NOT migrate the next node until quorum is confirmed
4. For agents: migrate in parallel (they do not participate in etcd)

## MetalLB Pool Migration

With all nodes on VLAN 20, MetalLB needed a new IP pool:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: server-vlan
  namespace: metallb-system
spec:
  addresses:
  - 192.168.20.200-192.168.20.220
```

Every LoadBalancer service got a new external IP. I updated DNS records for all services to point to the new IPs.

## NAS VLAN Isolation

The NAS was moved to VLAN 30 (Storage). This required configuring the switch ports connected to the NAS as access ports on VLAN 30, and setting up inter-VLAN routing rules:

![Synology NAS sitting atop rack-mounted equipment with blue status LEDs indicating active drives](nas-rack.jpg)

- VLAN 20 (k3s) → VLAN 30 (NAS): Allow NFS/SMB traffic
- VLAN 1 (clients) → VLAN 30 (NAS): Allow SMB for media access
- VLAN 30 → Internet: Block (no reason for the NAS to reach the internet)

The k3s applications access the NAS via NFS mounts that now cross the VLAN boundary through the firewall. Performance impact is negligible since the firewall handles inter-VLAN routing in hardware.

## Media Stack Deployment

With the network architecture sorted, I deployed the media stack:

### Jellyfin
Media server with hardware transcoding via Intel UHD 630 iGPU passthrough. The GPU passthrough infrastructure was set up today — IOMMU enabled on pve-3, VFIO modules loaded, i915 blacklisted, and the iGPU passed through to the k3s-agent-3 VM.

### The *arr Stack
- **Radarr**: Movie management and quality tracking
- **Sonarr**: TV series management and quality tracking
- **Prowlarr**: Indexer management (feeds Radarr and Sonarr)
- **Jellyseerr**: User request portal for media

All deployed in the `media` namespace with NFS mounts to the NAS for media storage:

```yaml
volumes:
- name: media
  nfs:
    server: 192.168.30.10
    path: /mnt/pool/media
```

### Monitoring the Media Stack

I deployed Exportarr sidecars alongside Radarr and Sonarr. Exportarr exposes application metrics (queue lengths, download status, library sizes) as Prometheus metrics. Accompanying Grafana dashboards show:

- Media library size and growth rate
- Download queue length and completion rate
- Quality profile distribution
- Disk usage trending

## UFW Rules Update

Every node's UFW firewall needed updates for the new IP ranges:

```bash
# Allow k3s API traffic from new VLAN 20 range
sudo ufw allow from 192.168.20.0/24 to any port 6443

# Allow Flannel VXLAN
sudo ufw allow from 192.168.20.0/24 to any port 8472

# Allow kubelet
sudo ufw allow from 192.168.20.0/24 to any port 10250
```

Ansible handled this across all nodes.

![Patch panel with color-coded ethernet cables — each color maps to a different VLAN](patch-panel.jpg)

## Lessons Learned

1. **Never migrate multiple etcd members simultaneously.** One at a time, verify quorum after each. This is the most important lesson of the day.
2. **`k3s server --cluster-reset` works.** Know this command. Test it. When etcd goes sideways, it is your recovery tool.
3. **VLANs drastically improve security posture.** Isolating storage traffic means a compromised k3s pod cannot sniff NAS traffic. Inter-VLAN routing rules enforce least-privilege network access.
4. **NFS across VLANs works fine.** The performance overhead of inter-VLAN routing for NFS traffic is negligible with modern firewalls.
5. **Plan network migrations on paper first.** Draw the before and after diagrams, list every IP that changes, and sequence the changes to maintain quorum.

The biggest infrastructure day so far. The cluster is now on a proper network architecture, and the media stack is operational. Tomorrow: automating media acquisition and sync.
