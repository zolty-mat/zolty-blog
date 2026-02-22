---
title: "Home Assistant on Kubernetes and Building a Proxmox Watchdog"
date: 2026-02-10T20:30:00-06:00
draft: false
author: "zolty"
description: "Deploying Home Assistant on k3s with hostNetwork and split routing, plus building an automated Proxmox watchdog that power-cycles unresponsive hosts via smart plugs."
tags: ["home-assistant", "kubernetes", "proxmox", "monitoring", "automation", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "Home Assistant and Proxmox monitoring"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Home Assistant runs on k3s using `hostNetwork: true` for mDNS/SSDP device discovery. I implemented split DNS routing so it is accessible both externally via Traefik and internally via its host IP. Then I built a Proxmox Watchdog — a custom service that monitors all Proxmox hosts via their API and automatically power-cycles unresponsive nodes using TP-Link Kasa HS300 smart power strips.

## Home Assistant on Kubernetes

Home Assistant is one of those applications that does not play well with Kubernetes out of the box. It needs to discover devices on the local network via mDNS, SSDP, and other broadcast protocols. Put it in a regular Kubernetes pod with cluster networking and it cannot see any of your smart home devices.

The solution: `hostNetwork: true`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: home-assistant
  namespace: home-assistant
spec:
  replicas: 1
  template:
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: home-assistant
        image: homeassistant/home-assistant:stable
        ports:
        - containerPort: 8123
          hostPort: 8123
```

When a pod uses `hostNetwork`, it shares the node's network namespace directly. This means Home Assistant sees all the same broadcast traffic as the host — mDNS announcements, SSDP discovery responses, everything. Device discovery works exactly as it would on a bare-metal install.

### The amd64 Gotcha

My first deployment failed because the Home Assistant image pulled was the wrong architecture. The pod was scheduled on an arm64 node (Lima) and Home Assistant was trying to run the amd64 image. Adding `nodeSelector` fixed it:

```yaml
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64
```

This is a recurring theme with mixed-architecture clusters. I will have a lot more to say about arm64 scheduling issues later this week.

### Split Routing

With `hostNetwork`, Home Assistant binds directly to the node's IP (e.g., 192.168.20.30:8123). I wanted it accessible both:

1. **Externally**: via `https://ha.zolty.systems` through Traefik ingress
2. **Internally**: via `http://192.168.20.30:8123` on the local network

The external route goes through Traefik with TLS termination. The internal route is direct to the host. An `ipWhiteList` middleware on the Traefik route restricts external access to known IPs, while internal access is unrestricted.

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: ha-ipwhitelist
  namespace: home-assistant
spec:
  ipWhiteList:
    sourceRange:
      - "192.168.0.0/16"
      - "10.0.0.0/8"
```

## Proxmox Hardware Monitoring

With VMs running on the Proxmox hosts, I wanted visibility into the physical hardware: CPU temperatures, fan speeds, power consumption. The approach:

1. **lm-sensors** on each Proxmox host to read hardware sensor data
2. **node-exporter** already deployed via Ansible, now configured with the textfile collector for sensor data
3. **Grafana dashboard** pulling from Prometheus to display per-host thermals

The sensor data gets exposed via node-exporter's textfile collector:

```bash
# Cron job on each PVE host
*/5 * * * * /usr/bin/sensors -j | /usr/local/bin/sensors-to-prom > /var/lib/prometheus/node-exporter/sensors.prom
```

This gives me time-series temperature data for each host, so I can see trends and get alerts if anything starts overheating.

## The Proxmox Watchdog

This is probably my favorite thing I have built for the cluster. The Proxmox Watchdog is a custom application that:

1. **Polls each Proxmox host** via the Proxmox API on a configurable interval
2. **Detects unresponsive hosts** — if a host does not respond after N consecutive failures
3. **Power-cycles the host** by turning off its outlet on the Kasa HS300 smart power strip, waiting 10 seconds, and turning it back on

### Why?

The M920q nodes are incredibly reliable, but I have had a few instances where a host becomes unresponsive — usually due to a kernel panic or a stuck Proxmox process. When that happens remotely, the only option is to physically power-cycle the machine. With the watchdog running inside the cluster, it handles this automatically.

### The TP-Link Kasa HS300

The HS300 is a 6-outlet smart power strip with individually controllable outlets. Each Proxmox host gets its own outlet. The watchdog uses the `python-kasa` library to control the strip:

```python
from kasa import SmartStrip

strip = SmartStrip("192.168.10.50")
await strip.update()

# Power cycle outlet 2 (pve-2)
await strip.children[2].turn_off()
await asyncio.sleep(10)
await strip.children[2].turn_on()
```

### Safety Mechanisms

An automated power-cycler needs safeguards:

- **Consecutive failure threshold**: The host must be unresponsive for N consecutive checks (default: 5) before triggering a power cycle. A single failed API call does not trigger anything.
- **Cooldown period**: After power-cycling a host, the watchdog waits 5 minutes before checking it again, giving it time to boot.
- **Network policies**: The watchdog pod's network policy restricts egress to only the Proxmox host IPs and the Kasa strip IP.
- **Slack notifications**: Every power cycle sends a Slack alert so I know when it happens.

### CoreDNS Gotcha

While debugging Home Assistant networking, I discovered a nasty gotcha: CoreDNS was running a single replica, and it was scheduled on the same node as one of the applications. When that node went down for testing, DNS resolution broke cluster-wide.

The fix: ensure CoreDNS has at least 2 replicas and use pod anti-affinity to spread them across different nodes:

```bash
kubectl -n kube-system patch deployment coredns --type=merge -p '{"spec":{"replicas":2}}'
```

This is a production readiness must-have that is easy to overlook in homelab setups.

## Dashboard Updates

I updated the cluster dashboard with a GitHub repositories section showing all project repos in the organization. The health check endpoint also got switched from HTTP to HTTPS to work properly with Traefik's TLS configuration — another small thing that costs 30 minutes of debugging.

## Lessons Learned

1. **`hostNetwork: true` is the right answer for Home Assistant on k3s.** Do not fight Kubernetes networking — just bypass it for workloads that need L2 network access.
2. **Smart power strips are legitimate infrastructure.** Automated power cycling sounds hacky, but it is exactly what datacenter IPMI provides. The Kasa HS300 is my budget IPMI.
3. **CoreDNS single replica is a cluster-wide SPOF.** Always run at least 2 replicas with anti-affinity. One DNS failure should not take down your entire cluster.
4. **Mixed-architecture clusters need explicit `nodeSelector`** on every workload that is not multi-arch. This will bite you repeatedly if you have both amd64 and arm64 nodes.

Tomorrow: deploying Digital Signage, a full-stack Angular + Flask application, to the cluster.
