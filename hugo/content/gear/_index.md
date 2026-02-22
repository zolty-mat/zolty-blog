---
title: "Recommended Gear"
date: 2026-02-21
author: "zolty"
description: "The hardware I use and recommend for building a production-grade homelab — every product listed here is something I personally run in my cluster."
ShowToc: false
ShowBreadCrumbs: true
---

Everything on this page is hardware I bought with my own money and use daily in my homelab. No sponsored placements, no paid reviews. If it is listed here, it has earned its spot by surviving production workloads.

Some links on this page are Amazon affiliate links — see the [disclosure](#) in the footer for details.

## Compute

<div class="gear-grid">

{{< gear-card
  title="Lenovo ThinkCentre M920q"
  search="Lenovo ThinkCentre M920q"
  price="~$100-150 (refurbished)"
  verdict="The best value homelab node. 6-core i5-8500T, supports 64GB DDR4, NVMe slot, silent operation, 15W idle. I run three of these as my Proxmox cluster."
>}}

{{< gear-card
  title="DDR4 SO-DIMM 32GB (2x16GB)"
  search="DDR4 SO-DIMM 32GB kit laptop"
  price="~$45-60"
  verdict="Max out each M920q with 64GB using two 32GB sticks. Start with 32GB if budget is tight — you will want 64GB eventually."
>}}

{{< gear-card
  title="NVMe SSD 512GB"
  search="NVMe SSD 512GB M.2 2280"
  price="~$35-50"
  verdict="Boot drive and VM storage for each node. 512GB is plenty for Proxmox + k3s VMs. The M920q takes standard M.2 2280."
>}}

</div>

## Networking

<div class="gear-grid">

{{< gear-card
  title="Mellanox ConnectX-3 10GbE NIC"
  search="Mellanox ConnectX-3 MCX311A-XCAT SFP+"
  price="~$15-20 (used)"
  verdict="10GbE for $15. In-kernel mlx4 driver, fits the M920q internal PCIe slot. Firmware flash may require two cold boots — see my blog post."
>}}

{{< gear-card
  title="DAC SFP+ Cable (1m)"
  search="DAC SFP+ cable 1m 10GbE"
  price="~$8-12"
  verdict="Direct attach copper for short runs between nodes. No SFP+ transceivers needed. Passive cables work fine for under 3 meters."
>}}

</div>

## Cooling

<div class="gear-grid">

{{< gear-card
  title="Noctua NF-A4x10 5V PWM"
  asin="B00NEMGCIA"
  price="~$15"
  verdict="40mm fan for tight enclosures. Dead silent, moves enough air to drop temps 5-10C in the M920q chassis. The 5V PWM version runs off USB headers."
>}}

{{< gear-card
  title="Noctua NH-L9i Low-Profile Cooler"
  asin="B009VCAJ7W"
  price="~$45"
  verdict="Low-profile CPU cooler for SFF builds. Not needed for the M920q (stock cooler is fine), but excellent for custom ITX homelab builds."
>}}

</div>

## Power & Monitoring

<div class="gear-grid">

{{< gear-card
  title="TP-Link Kasa HS300 Smart Power Strip"
  asin="B07G95FFN3"
  price="~$50-60"
  verdict="6 individually controllable outlets with energy monitoring. I use this as budget IPMI — the Proxmox Watchdog power-cycles unresponsive hosts via python-kasa."
>}}

{{< gear-card
  title="Kill A Watt P4400 Power Meter"
  asin="B00009MDBU"
  price="~$25-35"
  verdict="Essential for measuring actual power draw. My 3-node M920q cluster idles at 45W — data that justified the hardware choice over rack servers."
>}}

</div>
