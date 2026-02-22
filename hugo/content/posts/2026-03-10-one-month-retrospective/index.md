---
title: "One Month Retrospective: From Bare Metal to Production Platform"
date: 2026-03-10T20:00:00-06:00
draft: false
author: "zolty"
description: "A month-by-month timeline of building a production-grade homelab Kubernetes cluster -- from three bare Proxmox hosts to 8 nodes running 15+ applications with full observability, AI-powered operations, and 10GbE networking."
tags: ["homelab", "kubernetes", "retrospective", "timeline", "k3s"]
categories: ["Operations"]
cover:
  image: "/images/covers/operations.svg"
  alt: "One month retrospective"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

One month ago, I had three empty {{< amzn search="Lenovo ThinkCentre M920q" >}}Lenovo ThinkCentre M920q{{< /amzn >}} mini PCs and a Proxmox installer USB. Today, the cluster runs 8 Kubernetes nodes, 15+ applications, full observability with Prometheus and Grafana, AI-powered alert analysis, self-hosted CI/CD, 10GbE networking, and a 3D printer fabricating custom hardware. Total hardware cost: under $800. This post traces the entire journey, day by day, including the things that went wrong.

## The Starting Point

The goal was straightforward: build a production-grade Kubernetes cluster at home, entirely as code, where every component is reproducible from a git repository. No clicking through UIs. No manual configuration that exists only in someone's head. If the hardware caught fire, the entire platform should be rebuildable from `terraform apply` and `ansible-playbook`.

The hardware budget was under $500 for the initial cluster. The timeline was "as fast as possible." Here is what actually happened.

## Phase 1: Hardware and Genesis (Feb 7--8)

### Feb 7 -- Choosing the Hardware

After evaluating used enterprise rack servers, Intel NUCs, and various SFF options, the {{< amzn search="Lenovo ThinkCentre M920q" >}}ThinkCentre M920q{{< /amzn >}} won on every metric that matters for a homelab: $100-150 refurbished, Intel i5-8500T (6 cores), supports 64GB DDR4, NVMe slot, and idles at 15W. Three units came in under $450 total. Details in [Choosing the Hardware](/posts/2026-02-07-choosing-the-hardware/).

### Feb 8 -- Cluster Genesis

The most productive single day of the project. Starting from bare Proxmox hosts, I built the entire infrastructure-as-code pipeline: Terraform to provision VMs from Debian 13 cloud-init templates, Ansible to configure and bootstrap k3s in HA mode with embedded etcd. By end of day: 3 server nodes, 3 agent nodes, cert-manager with Route53 DNS-01 validation, self-hosted GitHub Actions runners via ARC, SOPS-encrypted secrets, and S3-backed Terraform state. Full writeup in [Cluster Genesis](/posts/2026-02-08-cluster-genesis/).

## Phase 2: First Applications (Feb 9--11)

### Feb 9 -- Marathon Deployment Day

The cluster was operational, so I started deploying applications immediately. In a single session: Cardboard (a TCG price tracker with Selenium scraping), Trade Bot (automated ETF trading with AI analysis), a cluster dashboard, PostgreSQL databases on Longhorn persistent storage, Prometheus ServiceMonitors for every service, a remote dev workspace, and scaled ARC runner replicas. See [First Applications](/posts/2026-02-09-first-applications/).

### Feb 10 -- Home Automation and Self-Healing

Home Assistant went onto the cluster with `hostNetwork: true` for mDNS/SSDP device discovery, plus split DNS to route between internal and external resolution. I also built a Proxmox Watchdog -- a custom service that monitors Proxmox hosts via their API and automatically power-cycles unresponsive nodes through a {{< amzn search="TP-Link Kasa HS300 Smart Power Strip" >}}TP-Link Kasa HS300{{< /amzn >}} smart strip. Covered in [Home Assistant and Watchdog](/posts/2026-02-10-home-assistant-and-watchdog/).

### Feb 11 -- Digital Signage Migration

The most complex deployment yet: an Angular SPA backed by 7 Flask microservices, an MQTT broker, and PostgreSQL -- migrated from a local dev environment to Kubernetes. Each microservice got its own Deployment, and the whole stack communicates over MQTT WebSockets through Traefik ingress. See [Digital Signage on k3s](/posts/2026-02-11-digital-signage-on-k3s/).

## Phase 3: CI/CD and Advanced Services (Feb 12--14)

### Feb 12 -- Self-Hosted CI/CD

GitHub Actions Runner Controller got a thorough configuration: RBAC for runner pods, scaling policies, and the label gotcha documented (the `labels` field in ARC *replaces* defaults entirely -- `self-hosted` disappears unless explicitly included). Full details in [Self-Hosted CI/CD](/posts/2026-02-12-self-hosted-cicd/).

### Feb 13 -- Microservices Architecture

A video service platform deployed: Vue.js frontend, 7 FastAPI backend services, NATS messaging for event-driven communication, plus PostgreSQL and Redis. This pushed the cluster's service mesh capabilities and proved NATS is a solid fit for k3s workloads. See [Microservices on k3s](/posts/2026-02-13-microservices-on-k3s/).

### Feb 14 -- AI-Powered Operations

The AI Alert Responder launched -- an agent that receives Prometheus AlertManager webhooks, enriches them with cluster context via the Kubernetes API, sends the data to AWS Bedrock (Amazon Nova Micro), and posts analysis with remediation suggestions to Slack. Also added multi-user dev workspaces and fixed the recurring arm64 scheduling problem. See [AI-Powered Alerts](/posts/2026-02-14-ai-powered-alerts/).

{{< ad >}}

## Phase 4: First Retrospective (Feb 15)

### Feb 15 -- Top 10 Production Failures

After one week of running production workloads, I documented the top 10 failures: Longhorn backup credential rotation silently breaking, etcd snapshot corruption, the service selector trap (50% of requests hitting PostgreSQL instead of Flask), and more. This post was the first sign that a formal knowledge management system was needed. See [Top 10 Production Failures](/posts/2026-02-15-top-10-production-failures/).

## Phase 5: Infrastructure Upgrades (Feb 16--20)

This was the most intense week. Five consecutive days of major infrastructure changes.

### Feb 16 -- VLAN Migration

The biggest infrastructure day. Migrated the entire cluster from a flat 192.168.1.0/24 network to a proper VLAN architecture: Server VLAN 20 for k3s nodes, Storage VLAN 30 for the NAS. I moved two etcd members simultaneously -- a mistake that broke quorum and took 20 minutes to recover with `k3s server --cluster-reset`. Also deployed the initial media stack (Jellyfin, Radarr, Sonarr, Prowlarr, Jellyseerr). See [VLAN Migration](/posts/2026-02-16-vlan-migration/).

### Feb 17 -- Complete Media Pipeline

The full media stack went operational: Jellyfin with Intel iGPU hardware transcoding, the complete *arr suite for media management, an rclone CronJob syncing from a remote seedbox to the local NAS, NFS storage integration across VLANs, plus custom Media Controller and Media Profiler services. See [Media Stack](/posts/2026-02-17-media-stack/).

### Feb 18 -- GPU Passthrough

Intel UHD 630 iGPU passed through from Proxmox to a k3s VM via IOMMU, VFIO driver binding, i915 blacklisting, and a q35/OVMF VM rebuild. This took Jellyfin from struggling with a single 4K stream at 100% CPU to handling 5+ simultaneous streams at under 10% CPU. See [GPU Passthrough](/posts/2026-02-18-gpu-passthrough/).

### Feb 19 -- Monitoring Stack

The full kube-prometheus-stack deployment: Prometheus, Grafana, AlertManager, and Loki for log aggregation. Custom dashboards for every service, alert tuning to reduce noise, and Exportarr sidecars for the media stack. Two weeks of ad-hoc monitoring was replaced with a proper observability platform. See [Monitoring Everything](/posts/2026-02-19-monitoring-everything/).

### Feb 20 -- 10GbE Networking

{{< amzn search="Mellanox ConnectX-3 MCX311A-XCAT SFP+" >}}Mellanox ConnectX-3{{< /amzn >}} NICs installed in all three Proxmox hosts at ~$15 each from eBay. Active-backup bonds with 10GbE primary and 1GbE fallback. One NIC required a firmware flash from 2.33.5220 to 2.42.5000 with `mstflint` -- the flash partially bricked the NIC and required two cold boots to recover. See [10GbE Networking](/posts/2026-02-20-10gbe-networking/).

## Phase 6: Platform Hardening (Feb 22--26)

### Feb 22 -- Benchmarks and AI Infrastructure

Two significant events on the same day. First, Prometheus and Grafana crashed with I/O errors, triggering a full hardware audit: SMART checks, fio NVMe benchmarks, sysbench CPU/memory tests, and iperf3 10GbE throughput across all four hosts. Root cause was Longhorn CSI virtual block device corruption, not physical disk failure. See [Cluster Benchmarks](/posts/2026-02-22-cluster-benchmarks/).

Second, I documented two weeks of building infrastructure with AI pair programming. Claude Opus 4.6 for multi-step infrastructure work, GitHub Copilot for inline completion, AWS Bedrock for runtime AI services. The critical discovery: AI tools without persistent memory recreate the same bugs across sessions. This led to the Memory Protocol. See [AI-Assisted Infrastructure](/posts/2026-02-22-ai-assisted-infrastructure/).

### Feb 26 -- AI Memory System

The Memory Protocol formalized. The `.github/copilot-instructions.md` file grew from 10 lines to 99 lines. A `docs/ai-lessons.md` file accumulated 482 lines of failure patterns across 20+ categories. Path-scoped `.github/instructions/` rules were added for context-specific guidance. The template was standardized across all 5 repositories. See [AI Memory System](/posts/2026-02-26-ai-memory-system/).

## Phase 7: Advanced AI and Physical Tooling (Mar 2--10)

### Mar 2 -- AI Failure Catalog

A full accounting of AI-caused production incidents: 14 documented failure patterns from the alert responder agent, a security scanner that applied `restricted` PodSecurity labels to every namespace (silently blocking pod creation for half the apps), and the service selector trap recurring 4 times before guardrails stopped it. A five-layer guardrail architecture was designed and documented. See [AI Failure Patterns](/posts/2026-03-02-ai-failure-patterns/).

### Mar 4 -- Private AI Chat

Open WebUI + LiteLLM proxy + AWS Bedrock deployed to provide a private ChatGPT alternative. Four models available: Claude Sonnet 4, Claude Haiku 4.5, Amazon Nova Micro, and Amazon Nova Lite. OAuth2 Proxy for authentication. Under 500MB total RAM, pay-per-request via Bedrock. See [Private AI Chat](/posts/2026-03-04-private-ai-chat/).

### Mar 6--8 -- 3D Printing

A {{< amzn search="Bambu Lab P1S 3D Printer" >}}Bambu Lab P1S{{< /amzn >}} 3D printer joined the homelab for fabricating custom hardware: node enclosures with hexagonal mesh ventilation, SFP+ cable routing brackets, rack shelves, and cable management clips. PETG filament at 265C nozzle / 80C bed -- significantly hotter than the advertised 230-250C range, but producing dramatically stronger parts. See [Bambu Lab P1S](/posts/2026-03-06-bambu-lab-p1s-3d-printing/) and [PETG Filament Settings](/posts/2026-03-08-petg-filament-settings/).

## The Numbers

One month in, here is where things stand:

| Metric | Value |
|--------|-------|
| **Kubernetes nodes** | 8 (3 control plane, 4 amd64 workers, 1 arm64 Mac Mini) |
| **Applications deployed** | 15+ |
| **Blog posts written** | 22 |
| **Total hardware cost** | Under $800 |
| **Cluster idle power draw** | ~55W |
| **Inter-node bandwidth** | 10GbE (active-backup bond) |
| **CI/CD runners** | 10 (8 amd64 + 2 arm64) |
| **Prometheus targets** | 40+ |
| **AI models available** | 6 (via Bedrock + direct API) |
| **3D printed parts** | 30+ functional homelab components |
| **Production incidents** | Too many to count, all documented |

## What Worked

**The ThinkCentre M920q as a homelab node.** The price-to-performance ratio is unbeatable. Six cores, 32GB RAM, NVMe, iGPU for transcoding, 15W idle -- all for $100-150 refurbished. Three of these outperform a single used rack server while using a fraction of the power and making no noise.

**Infrastructure as code from day one.** Every VM is Terraform-managed. Every OS configuration is Ansible-managed. Every application is deployed via kubectl manifests or Helm charts stored in git. When the VLAN migration broke etcd quorum, recovery was procedural, not panicked.

**Self-hosted ARC runners.** CI/CD running on the cluster itself eliminates external dependencies. Workflows push to GitHub, self-hosted runners pick them up, build containers, and deploy to the same cluster they run on. The feedback loop is fast and free.

**Embedded etcd for k3s HA.** External etcd adds operational complexity without meaningful benefit at homelab scale. The `--cluster-init` flag handles everything. Recovery with `--cluster-reset` has been tested and works.

**AI pair programming with the Memory Protocol.** Claude Opus 4.6 with proper persistent documentation (copilot-instructions.md, ai-lessons.md) is genuinely productive for infrastructure work. The key insight: the documentation is the product, not the AI output.

## What Did Not Work

**Moving multiple etcd members simultaneously.** During the VLAN migration, I moved server-2 and server-3 at the same time. Etcd lost quorum. The control plane was down for 20 minutes. One at a time, verify quorum after each. No exceptions.

**PLA for homelab parts.** PLA cable management clips near the M920q exhaust vents sagged after a few weeks. PLA has a glass transition temperature of ~60C -- too low for parts near running hardware. PETG solved this completely.

**AI without a memory protocol.** The first two weeks of AI-assisted development produced the same bugs repeatedly across sessions. The service selector trap appeared four separate times. Without externalized memory (documentation files the AI reads at session start), AI tools are productive but unreliable.

**Headless Chrome on the arm64 node.** The Mac Mini runs Lima with an arm64 kernel. Chrome and Selenium are amd64-only. Any scraping workload scheduled on the arm64 node crashes immediately. Every Selenium-based Job now has `nodeSelector: kubernetes.io/arch: amd64`.

## What Is Next

- **Statistical analysis of TCG market data** -- trend detection, price prediction, and sealed product value tracking for Pokemon and MTG
- **OpenClaw replacing Open WebUI** -- a lighter AI gateway with multi-channel support and direct Anthropic API integration
- **Additional GPU passthrough nodes** -- scaling hardware transcoding capacity by passing through iGPUs on pve-1 and pve-2
- **NFS to Longhorn migration** -- moving some workloads from NAS-backed NFS to Longhorn distributed storage for better performance

## Lessons Learned

1. **Start with infrastructure as code.** Retrofitting IaC onto a manually configured cluster is painful. Starting with Terraform and Ansible from day one means every change is tracked, reproducible, and recoverable.
2. **Deploy applications immediately.** A cluster with no workloads teaches you nothing about production operations. The failures from running real applications (database connections, persistent storage, ingress routing) are the lessons that matter.
3. **Document failures as they happen.** The `ai-lessons.md` file with 482 lines of failure patterns is the most valuable artifact in the repository. Every entry exists because its absence caused an incident.
4. **Budget for infrastructure weeks.** The Feb 16-20 stretch (VLANs, media stack, GPU passthrough, monitoring, 10GbE) was the most impactful period. These are not glamorous features, but they transformed the cluster from a toy into a platform.
5. **Buy refurbished enterprise hardware.** The {{< amzn search="Lenovo ThinkCentre M920q" >}}M920q{{< /amzn >}} at $100-150 delivers more value per dollar than any consumer hardware at any price point. The {{< amzn search="Mellanox ConnectX-3 MCX311A-XCAT SFP+" >}}Mellanox ConnectX-3{{< /amzn >}} at $15 delivers 10GbE for the price of a lunch. Used enterprise gear is the homelab cheat code.
6. **The AI memory problem is solvable.** Externalize knowledge into files the AI reads at session start. Update those files after every significant discovery. Four lines of protocol, 482 lines of lessons, zero recurring bugs.
7. **One month is enough.** A production-grade homelab Kubernetes platform does not require months of planning. It requires a weekend to bootstrap, a week to deploy applications, and another week to harden the infrastructure. The remaining time is spent operating, learning, and documenting.
