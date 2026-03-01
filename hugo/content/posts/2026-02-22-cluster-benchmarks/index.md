---
title: "Benchmarking Every Subsystem: NVMe, CPU, Memory, and 10GbE on Four Proxmox Hosts"
date: 2026-02-22T12:00:00-06:00
draft: false
author: "zolty"
description: "Full hardware benchmark results for four Lenovo M920q Proxmox hosts — NVMe SMART health, fio disk IOPS, sysbench CPU and memory bandwidth, iperf3 10GbE throughput, and the dramatic thermal impact of custom 3D-printed cooling."
tags: ["benchmarks", "hardware", "nvme", "proxmox", "homelab", "performance", "longhorn", "10gbe", "m920q", "noctua", "cooling", "mellanox"]
categories: ["Infrastructure"]
keywords: ["M920q benchmark", "Proxmox NVMe benchmark", "homelab 10GbE", "Longhorn volume corruption", "Noctua cooling M920q", "fio benchmark results", "sysbench i5-8500T vs i7-8700T", "OEM NVMe SSD performance"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "Benchmarking every subsystem on four Lenovo M920q Proxmox hosts — NVMe, CPU, memory, and 10GbE network"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Prometheus and Grafana both crashed with I/O errors on the same node. Before assuming software, I ran a full hardware audit across all four Proxmox hosts — SMART health, NVMe disk benchmarks (fio), CPU benchmarks (sysbench), memory bandwidth tests, and 10GbE network throughput (iperf3). The result: all hardware is healthy. The I/O errors were Longhorn CSI virtual block device corruption, not physical disk failure. Along the way, I established baseline performance numbers for every subsystem and discovered that custom cooling makes a dramatic difference in thermal performance.

{{< ad >}}

## The Incident

On February 22, 2026, I noticed Prometheus in CrashLoopBackOff with 81 restarts:

```
open /prometheus/queries.active: input/output error
panic: Unable to create mmap-ed active query log
```

Grafana followed:

```
unable to open database file: input/output error
```

Both pods were running on agent-4 (hosted on pve4). The kernel `dmesg` on agent-4 told the story:

```
critical medium error, dev sdk
Unrecovered read error - auto reallocate failed
Buffer I/O error, dev sdk
EXT4-fs error (device sdk): Detected aborted journal
```

That looks terrifying — `critical medium error` and `Unrecovered read error` sound like a dying drive. But `/dev/sdk` is not a physical disk. It is a Longhorn CSI virtual block device — a software-layer abstraction. The question was: is the physical hardware underneath actually failing?

Time to find out.

## The Hardware

The cluster runs on four {{< amzn search="Lenovo ThinkCentre M920q" >}}Lenovo ThinkCentre M920q{{< /amzn >}} mini PCs. Three run Intel i5-8500T processors, and the fourth (pve4) runs an i7-8700T — same physical chassis, same 35W TDP, but with Hyper-Threading and higher turbo clocks.

| Host | CPU | RAM | NVMe Drive | 10GbE NIC |
|------|-----|-----|-----------|-----------|
| pve1 | i5-8500T (6c/6t) | 24 GB DDR4 | Samsung PM9A1 512GB | Mellanox ConnectX-3 |
| pve2 | i5-8500T (6c/6t) | 32 GB DDR4 | SK hynix PC611 512GB | Mellanox ConnectX-3 |
| pve3 | i5-8500T (6c/6t) | 32 GB DDR4 | Samsung PM981a 512GB | Mellanox ConnectX-3 |
| pve4 | i7-8700T (6c/12t) | 32 GB DDR4 | WDC PC SN720 512GB | **None (1GbE only)** |

All four drives are OEM NVMe M.2 2280 SSDs — the kind you find in off-lease enterprise laptops and desktops. They cost $20-40 on eBay and outperform most consumer drives.

**One important detail about physical setup**: pve1, pve3, and pve4 are in their final rack positions. pve2 is not rack-mounted in its final configuration yet — it was sitting on a shelf during these tests. This may affect its thermal baseline slightly since airflow differs from the final rack arrangement.

## NVMe Health: SMART Data

First step: check if any drives are physically deteriorating.

| Host | Drive | Health | Available Spare | Wear | Media Errors | Temp | Power-On Hours |
|------|-------|--------|----------------|------|-------------|------|----------------|
| pve1 | Samsung PM9A1 | PASSED | 96% | 8% | **519** | 44°C | 14,943h |
| pve2 | SK hynix PC611 | PASSED | 100% | 0% | 0 | 34°C | 15,714h |
| pve3 | Samsung PM981a | PASSED | 100% | 0% | 0 | 44°C | 425h |
| pve4 | WDC PC SN720 | PASSED | 100% | 26% | 0 | 45°C | 42,270h |

All four drives passed SMART health. Two things worth noting:

**pve1's 519 media errors** sound alarming, but the error log shows "No Errors Logged" — these are firmware-level ECC corrections that incremented the counter without producing actual read failures. The drive still has 96% available spare. Worth monitoring quarterly.

**pve4's 42,270 power-on hours** (4.8 years) with 193 TB written and 26% wear — this drive has been through a lot, but the {{< amzn search="WD PC SN720 512GB NVMe" >}}WDC PC SN720{{< /amzn >}} is enterprise-rated at 400 TBW. Still has 207 TBW of life remaining.

## NVMe Performance: fio Benchmarks

With health confirmed, I ran `fio` benchmarks directly on each Proxmox host (not inside VMs, to eliminate virtualization overhead). All tests used `O_DIRECT` to bypass the page cache.

### Random 4K I/O (the metric that matters for databases and Kubernetes)

| Host | Drive | Rand Read IOPS | Rand Write IOPS |
|------|-------|---------------|-----------------|
| pve1 | Samsung PM9A1 | 359k | 359k |
| pve2 | SK hynix PC611 | 372k | 366k |
| pve3 | Samsung PM981a | 372k | 351k |
| pve4 | WDC PC SN720 | **427k** | **423k** |

### Sequential 1M I/O (the metric that matters for large file transfers and backups)

| Host | Drive | Seq Read | Seq Write |
|------|-------|----------|-----------|
| pve1 | Samsung PM9A1 | 7,659 MiB/s | 7,045 MiB/s |
| pve2 | SK hynix PC611 | 8,441 MiB/s | 7,667 MiB/s |
| pve3 | Samsung PM981a | 8,506 MiB/s | 7,609 MiB/s |
| pve4 | WDC PC SN720 | **9,538 MiB/s** | **8,780 MiB/s** |

The most-worn drive in the cluster (pve4's SN720, 26% used) is also the fastest. Zero errors across all benchmark runs on all hosts. Physical disks are not the problem.

{{< ad >}}

## CPU Benchmarks: sysbench

Next: CPU. I used `sysbench` for prime number calculation benchmarks — a simple but effective way to measure single-thread and multi-thread performance, and a good proxy for the kind of workloads Kubernetes scheduling cares about.

### Single-Thread (the metric that matters for latency-sensitive workloads)

| Host | CPU | Events/sec | Avg Latency |
|------|-----|-----------|-------------|
| pve1 | i5-8500T | 1,060 | 0.94 ms |
| pve2 | i5-8500T | 1,067 | 0.94 ms |
| pve3 | i5-8500T | 1,062 | 0.94 ms |
| pve4 | i7-8700T | **1,243** | **0.80 ms** |

The three i5-8500T hosts are within 1% of each other — essentially identical silicon. pve4's i7-8700T is 17% faster single-threaded, thanks to its higher turbo clock (4.0 GHz vs 3.5 GHz).

### Multi-Thread (all available threads)

| Host | CPU | Threads | Events/sec | Scaling vs Single |
|------|-----|---------|-----------|-------------------|
| pve1 | i5-8500T | 6 | 5,381 | 5.1x |
| pve2 | i5-8500T | 6 | 5,037 | 4.7x |
| pve3 | i5-8500T | 6 | 5,093 | 4.8x |
| pve4 | i7-8700T | **12** | **11,552** | **9.3x** |

pve4 with all 12 threads delivers 2.1x the throughput of any i5 host. Hyper-Threading provides 60% additional scaling beyond the 6 physical cores (7,218 events/sec at 6 threads → 11,552 at 12 threads). This is why pve4 hosts agent-4, the GPU worker with the heaviest compute allocation.

## The Cooling Story: Custom Cases vs Stock

This is where it gets interesting. I measured CPU temperatures at idle and immediately after 20 seconds of full multi-thread load:

| Host | Idle | Full Load | Delta | Custom Cooling |
|------|------|-----------|-------|----------------|
| pve1 | 49°C | 58°C | +9°C | **Yes** — 3D printed case + Noctua fan |
| pve2 | 44°C | 56°C | +12°C | **Yes** — 3D printed case + Noctua fan |
| pve3 | 48°C | 57°C | +9°C | **Yes** — 3D printed case + Noctua fan |
| pve4 | 49°C | **75°C** | **+26°C** | **No** — stock M920q chassis |

The delta tells the story. pve1/2/3 have custom 3D-printed ventilated cases with {{< amzn search="Noctua NF-A4x10 5V PWM 40mm fan" >}}Noctua NF-A4x10 5V PWM fans{{< /amzn >}} — a mod I covered in an upcoming 3D printing post. pve4 is running in the stock M920q chassis with the stock heatsink. The difference is dramatic:

- **With custom cooling**: +9 to +12°C under full load. The CPUs barely notice.
- **Without custom cooling**: +26°C under full load. Still safe (75°C is well below the 100°C thermal limit), but the i7 is working significantly harder to dissipate heat.

Two factors compound on pve4: the stock M920q chassis has limited airflow, and the i7-8700T dumps more heat than the i5-8500T thanks to Hyper-Threading and higher turbo clocks — all in the same 35W thermal envelope. Adding the custom case and Noctua fan to pve4 would likely bring it down to the 60-65°C range under load.

**A note on pve2**: It had the lowest idle temperature (44°C) despite running the same CPU and custom cooling as pve1 and pve3. pve2 is not rack-mounted in its final configuration yet — it was on a shelf with more open airflow during these tests, which likely explains the slight thermal advantage. Once it moves to its final rack position, expect idle temps closer to pve1 and pve3.

## Memory Bandwidth

Memory bandwidth is rarely the bottleneck in a Kubernetes cluster, but it is worth baselining. I used `sysbench` with 1MB blocks and 10GB total transfer:

### Single-Thread

| Host | CPU | Read (MiB/s) | Write (MiB/s) |
|------|-----|-------------|---------------|
| pve1 | i5-8500T | 21,656 | 18,658 |
| pve2 | i5-8500T | 21,786 | 18,587 |
| pve3 | i5-8500T | 21,922 | 18,686 |
| pve4 | i7-8700T | **26,425** | **21,698** |

Remarkably consistent across the i5 hosts. pve4 is 22% faster on reads — the i7-8700T's memory controller has a slight frequency advantage.

### Multi-Thread (6 threads)

| Host | Read (MiB/s) | Write (MiB/s) |
|------|-------------|---------------|
| pve1 | **112,164** | **77,872** |
| pve2 | 68,190 | 58,403 |
| pve3 | 85,188 | 60,554 |
| pve4 | 149,616 | 89,026 |

Multi-threaded memory bandwidth varies more — this reflects concurrent VM memory pressure during testing. pve1 led the i5 hosts despite having less RAM (24GB vs 32GB), likely because it had lower VM activity at test time. pve4 at 12 threads hits 163 GB/s read, which is essentially the DDR4 memory controller ceiling.

{{< ad >}}

## Network: 10GbE vs 1GbE

Three of the four hosts have {{< amzn search="Mellanox ConnectX-3 MCX311A-XCAT SFP+" >}}Mellanox ConnectX-3 10GbE NICs{{< /amzn >}} — a $15-20 eBay purchase that I [covered previously]({{< ref "/posts/2026-02-20-10gbe-networking" >}}). pve4 is still on the onboard Intel I219-LM 1GbE.

| Path | Link | Throughput | Retransmits |
|------|------|-----------|-------------|
| pve2 → pve1 | 10GbE | 9.39 Gb/s | 0 |
| pve3 → pve1 | 10GbE | 9.39 Gb/s | 0 |
| pve3 → pve2 | 10GbE | 9.37 Gb/s | 0 |
| pve2 ↔ pve1 (bidirectional) | 10GbE | 18.70 Gb/s aggregate | 0 |
| pve4 → pve1 | **1GbE** | **0.93 Gb/s** | 0 |
| pve4 → pve2 | **1GbE** | **0.93 Gb/s** | 0 |

All 10GbE paths hit 94% of theoretical maximum. Zero retransmits — clean links, no cable or switch issues.

The bidirectional test (full duplex) confirmed 18.7 Gb/s aggregate between pve2 and pve1. This matters for Longhorn, which simultaneously sends and receives data during volume replication.

pve4 at 0.93 Gb/s (93% of 1GbE max) is not terrible — but compared to the 10GbE hosts, its Longhorn volume replication bandwidth is 10x slower. Volume rebuilds after a node restart take 10x longer. **This bandwidth bottleneck on pve4 is the most likely contributing factor to the Longhorn volume corruption that started this whole investigation.**

## The Drives: OEM NVMe Specs and Models

For anyone building a similar cluster, here are the specific drives and their specs:

### Samsung PM9A1 512GB (pve1)

The {{< amzn search="Samsung PM9A1 NVMe 512GB M.2" >}}PM9A1{{< /amzn >}} is the OEM version of the Samsung 980 Pro — PCIe Gen 4 x4, Samsung Elpis controller, V-NAND TLC. Rated for 6,900 MB/s sequential read and 300 TBW endurance. Running on a Gen 3 slot in the M920q, so it cannot reach full Gen 4 speeds — but still delivered 7,659 MiB/s sequential reads in the benchmark. The 519 media errors bear watching, but the drive is healthy.

### SK hynix PC611 512GB (pve2)

The {{< amzn search="SK hynix PC611 NVMe 512GB" >}}PC611{{< /amzn >}} is the OEM equivalent of the SK hynix Gold P31 — PCIe Gen 3 x4, 96-layer TLC. Rated for 3,500 MB/s seq read, 300 TBW. The coolest-running drive in the cluster at 34°C. Solid all-around performer with zero anomalies.

### Samsung PM981a 512GB (pve3)

The {{< amzn search="Samsung PM981a NVMe 512GB" >}}PM981a (MZVLB512HBJQ){{< /amzn >}} is the OEM version of the 970 EVO Plus — PCIe Gen 3 x4, Phoenix controller, 64-layer V-NAND TLC. With only 425 power-on hours, this drive is essentially brand new. 333 error log entries are all `Invalid Field in Command` — a benign firmware compatibility issue with newer Linux kernels, common on Samsung enterprise drives.

### WDC PC SN720 512GB (pve4)

The {{< amzn search="WD PC SN720 NVMe 512GB" >}}PC SN720{{< /amzn >}} is an enterprise/workstation OEM drive — PCIe Gen 3 x4, WD proprietary controller, BiCS3 64-layer TLC. The highest endurance rating (400 TBW) and the most worn drive (26% used, 42,270 hours, 193 TB written). Despite all that, it is the fastest drive in the cluster by a meaningful margin: 427k random read IOPS and 9,538 MiB/s sequential reads. Enterprise drives earn their reputation.

## Root Cause Resolution

With all hardware confirmed healthy, the diagnosis is clear: the Longhorn CSI virtual block devices on agent-4 got into a bad state, most likely during the rolling node reboots I performed earlier for resource reallocation. With pve4's 1GbE bottleneck, Longhorn volume replicas had less bandwidth to resynchronize — increasing the window for state inconsistency.

The fix was straightforward:

1. Scale Prometheus to 0 replicas
2. Delete the corrupted PVC
3. Scale back to 1 — Longhorn creates a fresh volume
4. Delete the crashing Grafana pod for a fresh reschedule

Both Prometheus and Grafana recovered fully. Total downtime: about 30 minutes of investigation plus 5 minutes of actual remediation.

## Recommendations and Next Steps

Based on these benchmarks:

1. **Install 10GbE on pve4.** A Mellanox ConnectX-3 EN (MCX311A-XCAT) for $15-20 on eBay would bring pve4 to bandwidth parity and eliminate the Longhorn replication bottleneck that likely caused this incident.

2. **Print the custom case for pve4.** The 3D-printed ventilated case with a Noctua NF-A4x10 fan dropped load temperatures by 15-17°C on the other nodes. pve4 needs this even more since its i7-8700T runs hotter.

3. **Monitor pve1's SSD.** Quarterly SMART checks on the PM9A1. If media errors climb past 1,000, plan a proactive replacement (~$50-70 on eBay for another PM9A1).

4. **Rack-mount pve2.** It is currently not in its final rack position. Once properly racked with the other nodes, its thermals should be consistent with pve1 and pve3.

5. **Add Longhorn health alerting.** Alert on `longhorn_volume_robustness` degraded state so volume corruption is caught before it takes down monitoring.

## Lessons Learned

1. **Kernel I/O errors on `/dev/sdX` in Kubernetes are often Longhorn**, not physical disks. Check `lsblk` to see if the device is a Longhorn CSI volume before panicking about hardware failure.

2. **Custom cooling matters more than you think.** A $15 Noctua fan and a 3D-printed case turned a +26°C load delta into a +9°C one. For a 24/7 server, that is not cosmetic — it directly impacts silicon longevity and turbo boost sustainability.

3. **OEM NVMe drives are exceptional value.** These $20-40 enterprise pulls (PM9A1, PC611, PM981a, SN720) deliver 350k-427k random IOPS and 7-10 GB/s sequential reads. The "consumer equivalent" drives (980 Pro, Gold P31, 970 EVO Plus, WD Black) cost 3-4x more for the same silicon.

4. **1GbE is a liability in a Longhorn cluster.** Even one 1GbE node creates a weak link. Volume replication to that node is 10x slower, and the resynchronization window after reboots is wide enough for corruption. 10GbE is not a luxury — it is infrastructure insurance.

5. **Benchmark before you blame.** Spending 30 minutes on systematic benchmarks saved me from replacing hardware that was working perfectly. The data pointed clearly at a software-layer problem, which was fixed in 5 minutes.

