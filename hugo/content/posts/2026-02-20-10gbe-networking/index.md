---
title: "10GbE Networking on a Budget: Mellanox ConnectX-3 and Bricked NICs"
date: 2026-02-20T21:00:00-06:00
draft: false
author: "zolty"
description: "Upgrading the homelab to 10GbE with used Mellanox ConnectX-3 NICs — including the firmware flash that bricked a NIC and the cold boot recovery procedure."
tags: ["networking", "10gbe", "mellanox", "firmware", "homelab"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "10GbE networking upgrade"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

I upgraded the inter-node networking from 1GbE to 10GbE using Mellanox ConnectX-3 NICs from eBay (~$15-20 each). Two of the three NICs worked immediately. The third needed a firmware flash from 2.33.5220 to 2.42.5000 using `mstflint`, which required two cold boots to recover from a partially bricked state. All three Proxmox hosts now have 10GbE connectivity via active-backup bonds. I also deployed Security Scanner infrastructure and fixed ARC runner Pod Security Standards.

## Why 10GbE?

With Longhorn replicating volumes across nodes, storage traffic between nodes is constant. On 1GbE, I measured:

- **Volume replication during writes**: 400-600 Mbps (40-60% of available bandwidth)
- **Volume rebuild after node restart**: 938 Mbps (saturated for 10-15 minutes)
- **NFS media playback during replication**: Stuttering, buffering

The 1GbE link was the bottleneck. 10GbE gives 10x the headroom for inter-node traffic while leaving plenty of bandwidth for services.

## Hardware Selection

Mellanox ConnectX-3 NICs are the sweet spot for homelab 10GbE:

| Feature | Detail |
|---------|--------|
| **Model** | Mellanox ConnectX-3 (MCX311A-XCAT) |
| **Speed** | 10GbE SFP+ |
| **Interface** | PCIe 3.0 x4 (fits M920q internal slot) |
| **Price** | $15-20 on eBay (used, pulled from datacenter gear) |
| **Driver** | mlx4_en (in-kernel, no DKMS needed) |
| **Power** | ~5W under load |

The M920q has an internal PCIe slot intended for a Wi-Fi card, but it is electrically a standard x4 PCIe slot. The ConnectX-3 fits perfectly.

For cabling, I use DAC (Direct Attach Copper) SFP+ cables between nodes — about $10 each for 1-meter cables. No need for SFP+ transceivers or fiber for short runs within the same rack.

## Installation

### Physical Installation

The ConnectX-3 is a low-profile card that fits the M920q's internal expansion slot:

1. Open the M920q (single screw on the back)
2. Remove the Wi-Fi card bracket (if present)
3. Insert the ConnectX-3 into the PCIe slot
4. Route the SFP+ cable out the back (I 3D printed a bracket for this)
5. Close the chassis

### Network Bond Configuration

I configured an active-backup bond on each Proxmox host, combining the 10GbE NIC with the onboard 1GbE:

```
# /etc/network/interfaces on each PVE host

auto bond0
iface bond0 inet manual
    bond-slaves eno1 enp1s0
    bond-mode active-backup
    bond-primary enp1s0
    bond-miimon 100

auto vmbr0
iface vmbr0 inet static
    address 192.168.20.105/24
    gateway 192.168.20.1
    bridge-ports bond0
    bridge-stp off
    bridge-fd 0
```

The 10GbE interface (`enp1s0`) is primary. If it fails, traffic falls back to the onboard 1GbE (`eno1`). This provides both high bandwidth and redundancy.

## The Firmware Brick

Two of the three NICs (pve-2 and pve-3) had recent firmware and worked out of the box. The third (pve-1) had firmware version 2.33.5220 — old enough that some features were not supported.

### Flashing Firmware

I used `mstflint` to flash the firmware:

```bash
# Install mstflint on Proxmox host
apt install mstflint

# Find the device
mstflint -d /dev/mst/mt4099_pci_cr0 query
# FW Version: 2.33.5220

# Flash new firmware
mstflint -d 04:00.0 -i fw-ConnectX3-rel-2_42_5000-MCX311A-XCA_Ax-FlexBoot-3.4.752.bin burn
```

### The Brick

After flashing, the NIC did not come back. `lspci` still showed the device but the network interface was gone. The firmware was partially written — the NIC was in an indeterminate state.

### The Recovery

The key insight: Mellanox ConnectX-3 firmware flash requires **two cold boots** (not warm reboots) to fully apply.

```bash
# First cold boot: Power off completely, wait 10 seconds, power on
# NIC may still not work

# Second cold boot: Power off completely, wait 10 seconds, power on
# NIC should now function with new firmware

# Verify
mstflint -d /dev/mst/mt4099_pci_cr0 query
# FW Version: 2.42.5000
```

The reason: the ConnectX-3 has two firmware banks (primary and backup). The flash writes to one bank, and the first cold boot switches the active bank. The second cold boot finalizes the configuration. A warm reboot does not trigger the bank switch.

This is documented in Mellanox release notes but buried deep enough that most people miss it. I nearly ordered a replacement NIC before discovering this.

### The BDF Method

For NICs that do not show up as `/dev/mst/` devices (common after a partial flash), use the BDF (Bus:Device.Function) method:

```bash
# Find the PCI BDF
lspci | grep Mellanox
# 04:00.0 Ethernet controller: Mellanox Technologies MT27500 Family [ConnectX-3]

# Flash using BDF directly
mstflint -d 04:00.0 -i firmware.bin burn
```

## Performance After Upgrade

With 10GbE on all three nodes:

| Metric | 1GbE | 10GbE | Improvement |
|--------|------|-------|-------------|
| iperf3 throughput | 938 Mbps | 9.41 Gbps | 10x |
| Longhorn rebuild time | 15 min | 2 min | 7.5x |
| NFS media streaming | Stutters during rebuild | Smooth always | Quality |
| Concurrent Longhorn replications | Saturated at 2 | No saturation | Headroom |

The biggest quality-of-life improvement is Longhorn volume rebuilds. After a node restart, Longhorn needs to resynchronize volume replicas. At 1GbE, this took 15 minutes and impacted all services. At 10GbE, it completes in 2 minutes and is barely noticeable.

## Security Scanner Deployment

Also today, I set up the infrastructure for a Security Scanner service:

- Bedrock IAM outputs in Terraform for the scanner's AI analysis
- Kubernetes namespace and RBAC for the scanner pods
- ECR repository for the scanner container image

The Security Scanner will analyze Kubernetes configurations for security issues (pod security contexts, network policies, RBAC over-permissions) and report findings, powered by AWS Bedrock for analysis.

## ARC Runner Pod Security

The ARC runners needed a Pod Security Standard change. With Docker-in-Docker (DinD) sidecars for container image builds, the runner pods require privileged access. I updated the runner namespace PSS to `privileged`:

```bash
kubectl label namespace arc-system pod-security.kubernetes.io/enforce=privileged --overwrite
```

This is a security tradeoff. The runners are trusted infrastructure, and DinD inherently requires privileged mode for Linux namespace isolation. The alternative (kaniko or buildah for rootless builds) would require significant workflow changes.

## Firmware Documentation

I documented the ConnectX-3 firmware 2.42.5000 release notes in the hardware wiki:

- **New features**: Enhanced SR-IOV support, improved power management
- **Bug fixes**: Several stability fixes for active-backup bonds
- **Known issues**: Wake-on-LAN not supported on some PCIe slot configurations
- **Security**: Addresses CVEs in the management interface
- **Upgrade path**: 2.33.5220 → 2.42.5000 (direct flash, no intermediate versions needed)

## Lessons Learned

1. **Used Mellanox ConnectX-3 NICs are incredible value.** $15 for 10GbE that just works (mostly) with in-kernel drivers. No DKMS, no proprietary drivers.
2. **ConnectX-3 firmware flash requires two cold boots.** Not warm reboots — full power-off cycles. This is critical to know before you panic about a bricked NIC.
3. **The BDF method is your fallback** when `/dev/mst/` devices disappear after a partial flash.
4. **Active-backup bonds provide both speed and redundancy.** The 10GbE NIC is primary, with 1GbE fallback.
5. **10GbE dramatically improves Longhorn performance.** Volume rebuilds, replication, and concurrent I/O all benefit from the extra bandwidth.

Two weeks of building, and the cluster has gone from bare hardware to a production platform with 13 applications, comprehensive monitoring, VLAN isolation, GPU transcoding, and 10GbE networking. The infrastructure is solid. Now it is time to focus on content and operations.
