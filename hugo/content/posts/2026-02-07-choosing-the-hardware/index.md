---
title: "Choosing the Hardware: Why I Went with Lenovo M920q for My Homelab"
date: 2026-02-07T20:00:00-06:00
draft: false
author: "zolty"
description: "How I chose the Lenovo ThinkCentre M920q as the foundation for a production-grade k3s homelab cluster, and why tiny form factor PCs are the best kept secret in homelabbing."
tags: ["homelab", "hardware", "proxmox", "lenovo", "m920q"]
categories: ["Infrastructure"]
cover:
  image: ""
  alt: "Homelab hardware selection"
  hidden: true
ShowToc: true
TocOpen: false
---

## TL;DR

After researching rack servers, NUCs, and mini PCs, I settled on the Lenovo ThinkCentre M920q as my homelab node of choice. At roughly $100-150 used, each unit packs an Intel 8th-gen Coffee Lake CPU, supports up to 64GB DDR4, has an NVMe slot, and sips around 15-25W. Three of these running Proxmox VE give me a proper HA cluster without the noise, heat, or power bill of traditional rack gear.

## The Requirements

I wanted to build a Kubernetes cluster that could run real workloads — not just a learning exercise, but something I would actually depend on daily. That meant:

- **High availability**: At least 3 nodes for etcd quorum
- **Low power**: These run 24/7 in a home office, not a datacenter
- **Low noise**: Silent or near-silent operation
- **Enough compute**: Each node needs to handle multiple VMs and containers
- **Expandable**: Room to grow storage and memory
- **Budget-friendly**: Under $500 for the initial cluster

## Why Not Traditional Rack Servers?

I briefly considered used Dell R720s or HP DL380s from eBay. You can get incredible hardware for cheap — dual Xeons, 128GB+ RAM, tons of drive bays. But the tradeoffs killed it for me:

- **Power draw**: 200-400W per server, idle. Three of them would cost more in electricity per year than the hardware itself.
- **Noise**: Even with fan mods, enterprise rack servers are loud. My cluster lives in the same room where I work.
- **Heat**: Three rack servers would turn my office into a sauna.
- **Size**: I do not have a server rack, and did not want one in a living space.

## The M920q Sweet Spot

The Lenovo ThinkCentre M920q hit every requirement:

| Spec | Detail |
|------|--------|
| **CPU** | Intel i5-8500T (6 cores, 6 threads, 1.7-3.5GHz) |
| **RAM** | 2x SO-DIMM DDR4 slots, up to 64GB |
| **Storage** | 1x M.2 NVMe + 1x 2.5" SATA bay |
| **Networking** | 1GbE Intel I219-LM |
| **GPU** | Intel UHD 630 (IOMMU capable for passthrough) |
| **TDP** | 35W CPU, ~15-25W system idle |
| **Form Factor** | 1L Tiny — 179 x 183 x 34.5mm |
| **Price** | $100-150 on the used market |

The 8th-gen Coffee Lake architecture was the key differentiator. It supports VT-d for proper IOMMU passthrough (important for GPU passthrough later), and the i5-8500T gives 6 real cores without hyperthreading overhead — perfect for virtualization workloads.

## The Configuration

I started with 3 identical nodes:

- **pve-1**: i5-8500T, 32GB DDR4, 512GB NVMe
- **pve-2**: i5-8500T, 32GB DDR4, 512GB NVMe
- **pve-3**: i5-8500T, 32GB DDR4, 512GB NVMe

Each node runs Proxmox VE 8.x and hosts k3s VMs — 3 server nodes for the control plane and 3 agent nodes for workloads. The total footprint? Three tiny boxes that stack on top of each other, draw about 60W combined at idle, and are completely silent.

## Upgrade Path

The M920q platform has a clear upgrade path:

- **RAM**: Each slot takes up to 32GB SO-DIMMs, so 64GB per node is possible. I started with 32GB each which gives me plenty of headroom.
- **Storage**: The NVMe slot handles boot + VM storage, and the 2.5" bay can add a SATA SSD for extra Longhorn capacity. I am using `additional_disks` in Terraform to manage secondary storage for Longhorn distributed volumes.
- **Networking**: The built-in 1GbE is fine to start, but the M920q has an internal PCIe slot. I later added Mellanox ConnectX-3 10GbE NICs for inter-node traffic.
- **GPU**: The Intel UHD 630 supports VFIO passthrough through Proxmox, which I use for Jellyfin hardware transcoding.

## Power and Thermal Considerations

I measured power consumption with a Kill-A-Watt meter:

- **Single node idle**: ~15W
- **Single node under load**: ~25W
- **3-node cluster idle**: ~45W
- **3-node cluster under load**: ~75W

Compare that to a single Dell R720 idling at 200W+. Over a year at $0.12/kWh, my entire 3-node cluster costs about **$47/year** in electricity. A single rack server would cost **$210/year**.

Thermally, the M920q is fanless at idle and nearly inaudible under load. The internal fan only spins up during sustained CPU activity, and even then it is barely perceptible.

## Proxmox Cluster Formation

Once the hardware arrived, I installed Proxmox VE 8.x on each node's NVMe drive via USB boot. Forming the Proxmox cluster took about 10 minutes:

```bash
# On pve-1 (first node)
pvecm create homelab-cluster

# On pve-2 and pve-3
pvecm add 192.168.20.105
```

With a 3-node Proxmox cluster, I get:

- **Quorum**: Corosync handles cluster membership with proper quorum voting
- **Live migration**: VMs can move between nodes during maintenance
- **Shared configuration**: Changes propagate across all nodes automatically
- **HA fencing**: Proxmox can fence and restart VMs if a node fails

## What I Would Do Differently

Looking back, there is one thing I would change:

**Start with 64GB RAM per node.** I went with 32GB thinking it would be enough, and it is — for now. But as the applications grew, memory became the tightest resource. An extra $30 per node for 64GB would have been worthwhile from day one.

Everything else about the M920q choice has been validated by experience. The form factor, power efficiency, noise levels, and upgrade path have all exceeded expectations.

## Lessons Learned

1. **Used enterprise mini PCs are the homelab sweet spot**. You get enterprise-grade reliability (ThinkCentre build quality, Intel AMT for remote management) at consumer prices.
2. **Power efficiency matters more than raw specs** when running 24/7. The savings compound quickly.
3. **Plan for GPU passthrough from the start** — the 8th-gen Intel CPUs with VT-d support make this possible, and it opens up use cases like hardware transcoding that would otherwise require dedicated hardware.
4. **Buy identical hardware**. Having homogeneous nodes simplifies everything — same firmware, same drivers, same Ansible roles, same Terraform modules.

Tomorrow: actually building the cluster. Time to turn three tiny PCs into a production Kubernetes platform.
