---
title: "GPU Passthrough on Proxmox for Hardware Transcoding"
date: 2026-02-18T19:00:00-06:00
draft: false
author: "zolty"
description: "A complete guide to passing through Intel UHD 630 iGPU from Proxmox to a k3s VM for Jellyfin hardware transcoding — IOMMU, VFIO, VA-API, and all the troubleshooting."
tags: ["gpu", "proxmox", "transcoding", "jellyfin", "iommu", "homelab"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "GPU passthrough"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Intel iGPU passthrough from Proxmox to a k3s VM enables hardware video transcoding with minimal CPU overhead. This guide covers the complete process: enabling IOMMU, configuring VFIO, blacklisting the i915 driver, rebuilding the VM with q35/OVMF, and verifying VA-API inside the VM. The Intel UHD 630 in the M920q handles H.264 and HEVC encode/decode at real-time speeds.

## Why GPU Passthrough?

Software transcoding (libx264/libx265) on a 6-core i5-8500T is limited:

- **1 stream of 4K HEVC → 1080p H.264**: 100% CPU, barely real-time
- **2 simultaneous streams**: Not possible without frame drops
- **CPU contention**: Other workloads on the same node suffer

Hardware transcoding via Intel Quick Sync Video:

- **1 stream of 4K HEVC → 1080p H.264**: ~5% CPU
- **5+ simultaneous streams**: No problem
- **Zero contention**: GPU handles transcoding independently

## The Challenge

Proxmox runs as the hypervisor on bare metal. The Intel UHD 630 is an integrated GPU — part of the CPU package, not a discrete card. Passing it through to a VM requires:

1. IOMMU (Input/Output Memory Management Unit) for device isolation
2. VFIO (Virtual Function I/O) driver to claim the device from the host
3. Blacklisting the i915 (Intel graphics) driver so the host does not grab the GPU first
4. q35 machine type and OVMF (UEFI) BIOS in the VM to support PCIe passthrough

## Phase 0: BIOS Configuration

The Lenovo M920q BIOS needs VT-d (Intel Virtualization Technology for Directed I/O) enabled:

```
BIOS → Security → Virtualization
  → Intel VT-d = Enabled
```

This is a prerequisite. Without VT-d, IOMMU will not initialize.

## Phase 1: Proxmox Host Preparation

I automated this with an Ansible playbook (`proxmox-gpu-prep.yml`) that configures:

### GRUB Configuration

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"
```

- `intel_iommu=on`: Enable IOMMU
- `iommu=pt`: Passthrough mode — only devices explicitly assigned to VFIO get IOMMU protection. Other devices use direct DMA for performance.

### Kernel Modules

```bash
# /etc/modules-load.d/vfio.conf
vfio
vfio_iommu_type1
vfio_pci
```

### Driver Blacklist

```bash
# /etc/modprobe.d/blacklist-gpu.conf
blacklist i915
blacklist snd_hda_intel
```

The `i915` blacklist prevents the Proxmox host from claiming the GPU. `snd_hda_intel` is the HDMI audio device on the same IOMMU group — it must also be blacklisted.

### Apply and Reboot

```bash
update-grub
update-initramfs -u
reboot
```

### Verify IOMMU

After reboot:

```bash
dmesg | grep -i iommu
# DMAR: IOMMU enabled

lspci -nn | grep VGA
# 00:02.0 VGA compatible controller: Intel Corporation CoffeeLake-S GT2 [UHD Graphics 630] [8086:3e92]

# Verify the GPU is in its own IOMMU group
find /sys/kernel/iommu_groups/ -type l | grep 00:02.0
```

## Phase 2: VM Rebuild with Terraform

Standard Proxmox VMs use the `pc-i440fx` machine type with SeaBIOS. PCIe passthrough requires the `q35` machine type with OVMF (UEFI) firmware. This is not a hot-reconfigurable setting — it requires destroying and recreating the VM.

```hcl
# terraform.tfvars
{
  name             = "k3s-agent-3"
  vm_id            = 122
  proxmox_node     = "pve-3"
  ip_address       = "192.168.20.32/24"
  cores            = 4
  memory           = 8192
  machine_type     = "q35"
  bios             = "ovmf"
  gpu_passthrough  = [
    {
      device = "0000:00:02.0"
      pcie   = true
      rombar = true
      xvga   = false
    }
  ]
}
```

Before applying:

```bash
# Drain workloads from the node
kubectl drain k3s-agent-3 --ignore-daemonsets --delete-emptydir-data

# Apply Terraform (destroys and recreates the VM)
terraform apply -target='module.k3s_agents["k3s-agent-3"]'
```

### Authentication Requirement

The Proxmox Terraform provider's `hostpci` block requires `root@pam` authentication (username + password). API tokens cannot assign PCI devices. This is a Proxmox API limitation, not a Terraform limitation.

## Phase 3: GPU Worker Provisioning

After Terraform recreates the VM, an Ansible playbook (`gpu-worker.yml`) configures the guest:

```bash
ansible-playbook -i inventory/homelab playbooks/gpu-worker.yml --limit k3s-agent-3
```

The playbook installs:

- `intel-media-va-driver-non-free`: VA-API driver for Intel GPUs (the non-free version supports HEVC encoding)
- `vainfo`: VA-API diagnostic tool
- `intel-gpu-tools`: GPU monitoring utilities

### Verify GPU in VM

```bash
ssh debian@k3s-agent-3

ls -la /dev/dri/
# card0  renderD128

vainfo
# vainfo: VA-API version: 1.20
# vainfo: Driver version: Intel iHD driver - 25.2.3
# vainfo: Supported profile and entrypoints
#   VAProfileH264Main            : VAEntrypointVLD
#   VAProfileH264Main            : VAEntrypointEncSlice
#   VAProfileHEVCMain            : VAEntrypointVLD
#   VAProfileHEVCMain            : VAEntrypointEncSlice
#   VAProfileVP9Profile0         : VAEntrypointVLD
```

The `VLD` (decode) and `EncSlice` (encode) entries confirm hardware acceleration is working.

## Phase 4: Kubernetes Labels

The GPU node gets labeled so workloads can request GPU scheduling:

```bash
kubectl label node k3s-agent-3 gpu=intel-uhd-630 cpu-tier=high
```

Jellyfin's deployment uses `nodeSelector: gpu: intel-uhd-630` to land on this node.

## Scaling to Additional Nodes

The M920q nodes all have the same Intel UHD 630 iGPU. The process to add GPU passthrough to additional nodes:

1. Run `proxmox-gpu-prep.yml --limit pve-1` (or pve-2)
2. Add `gpu_passthrough` configuration to the corresponding agent in `terraform.tfvars`
3. `terraform apply` (destroys + recreates that agent VM)
4. Run `gpu-worker.yml --limit <node>`
5. Label the node: `kubectl label node <node> gpu=intel-uhd-630`

Each additional GPU node increases transcoding capacity. With 3 GPU nodes, the cluster could handle 15+ simultaneous transcoding streams.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `dmesg` shows no IOMMU | Check VT-d in BIOS. Rerun gpu-prep playbook |
| VM will not start after GPU add | Verify IOMMU group isolation. Check `qm config <vmid>` |
| `/dev/dri` missing in VM | Ensure `hostpci0` in VM config. Check `lspci` inside VM |
| `vainfo` shows no profiles | Install `intel-media-va-driver-non-free`. Rerun gpu-worker playbook |
| Terraform cannot set `hostpci` | Verify `proxmox_username = "root@pam"` (not API token) |
| OVMF boot fails | Ensure cloud-init template supports UEFI or create new UEFI template |

## Performance Comparison

| Scenario | Software (CPU) | Hardware (iGPU) |
|----------|---------------|------------------|
| 1080p H.264 decode | 15% CPU | ~0% CPU |
| 4K HEVC decode | 80% CPU | ~2% CPU |
| 1080p H.264 encode | 60% CPU | ~3% CPU |
| 4K→1080p transcode | 100% CPU (barely real-time) | ~5% CPU |
| Concurrent streams | 1-2 max | 5+ comfortable |

## Lessons Learned

1. **iGPU passthrough is completely viable** on the M920q platform. The Intel UHD 630 handles Jellyfin transcoding workloads with ease.
2. **q35 + OVMF is mandatory** for PCIe passthrough. Plan for this from the start if GPU passthrough is in your roadmap.
3. **The `non-free` VA-API driver is essential** for HEVC encoding. The open-source driver only supports decode.
4. **`root@pam` authentication** is required for PCI device assignment in Proxmox. API tokens will not work.
5. **Automate everything with Ansible.** GPU host preparation involves modifying GRUB, kernel modules, and driver blacklists — all error-prone if done manually. The playbook makes it reproducible and auditable.

GPU passthrough is one of those homelab capabilities that feels like magic when it works. The Intel UHD 630 is not a powerhouse, but for real-time transcoding of typical media files, it delivers exactly what is needed.
