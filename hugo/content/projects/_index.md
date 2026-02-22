---
title: "Projects"
date: 2026-02-21
author: "zolty"
description: "A showcase of projects built and running on the homelab k3s cluster — from infrastructure automation to AI-powered trading and self-hosted media management."
ShowToc: true
ShowBreadCrumbs: true
---

Everything listed here runs on the same homelab k3s cluster — three Lenovo ThinkCentre M920q mini PCs, a 10GbE backbone, and a lot of YAML. Every project deploys via GitHub Actions on self-hosted runners, stores data in PostgreSQL on Longhorn distributed storage, and exposes Prometheus metrics for monitoring.

## Homelab Kubernetes Platform

The foundation that everything else runs on. A 3-node Proxmox VE cluster hosting a k3s Kubernetes distribution in HA mode with embedded etcd. All infrastructure is defined as code — Terraform provisions the VMs, Ansible configures the OS, and Helm charts deploy the platform services.

**Stack:** Proxmox VE / k3s / Terraform / Ansible / Longhorn / Traefik / MetalLB

- 8 Kubernetes nodes: 3 control plane + 4 amd64 workers (Proxmox VMs) + 1 arm64 Mac Mini (Lima VM)
- 10GbE inter-node backbone with Mellanox ConnectX-3 NICs and a UniFi Aggregation switch
- Self-hosted GitHub Actions runners via ARC (8 amd64 + 2 arm64)
- cert-manager with Let's Encrypt DNS-01 validation via Route53
- Full observability: Prometheus + Grafana + Loki + AlertManager

**Blog posts:** [Choosing the Hardware](/posts/2026-02-07-choosing-the-hardware/) · [Cluster Genesis](/posts/2026-02-08-cluster-genesis/) · [Self-Hosted CI/CD](/posts/2026-02-12-self-hosted-cicd/) · [VLAN Migration](/posts/2026-02-16-vlan-migration/) · [GPU Passthrough](/posts/2026-02-18-gpu-passthrough/) · [Monitoring Everything](/posts/2026-02-19-monitoring-everything/) · [10GbE Networking](/posts/2026-02-20-10gbe-networking/)

[GitHub](https://github.com/zolty-mat/home_k3s_cluster)

---

## Digital Signage

A self-hosted home dashboard system that displays real-time data on Raspberry Pi kiosk screens. Shows calendar events, weather, chore schedules, and Home Assistant device controls. Features a drag-and-drop WYSIWYG grid editor so each display can have a unique layout, stored as JSONB per device.

**Stack:** Angular 20 / Flask microservices / PostgreSQL / MQTT / Web Speech API

- Microservice architecture — separate Flask services per data source behind a single Traefik ingress with path-based routing
- MQTT-based device management for remote control of displays
- Voice control via Web Speech API for hands-free interaction
- OLED burn-in prevention via pixel shifting
- Per-device layouts stored as JSONB in PostgreSQL

**Blog post:** [Digital Signage on k3s](/posts/2026-02-11-digital-signage-on-k3s/)

[GitHub](https://github.com/zolty-mat/digital_signage)

---

## Media Library

A self-hosted blog asset management system for this site. Handles photo and video uploads, generates AI-powered metadata (alt text, tags, descriptions) via AWS Bedrock, transcodes video for both web delivery and YouTube, and produces ready-to-paste Hugo shortcodes.

**Stack:** Python / FastAPI / PostgreSQL / S3 + CloudFront / AWS Bedrock / FFmpeg

- Full upload-to-CDN pipeline — drag and drop a photo, get a Hugo shortcode back
- AI-generated metadata via Claude on AWS Bedrock (alt text, tags, titles, descriptions)
- Dual video transcode pipeline: web-optimized (CRF 23) and YouTube-optimized (CRF 18)
- YouTube upload with resumable chunked uploads and exponential backoff
- Split architecture: web deployment serves the UI, worker deployment handles transcoding and uploads

[GitHub](https://github.com/zolty-mat/media-library)

---

## Trading Bot

An automated ETF trading bot that monitors and trades on Robinhood using AI-powered price predictions. Implements swing trading with full PDT (Pattern Day Trader) compliance. Ships with safety defaults — dry run and paper trading are enabled by default.

**Stack:** Python / Flask / PostgreSQL / AWS Bedrock (Claude) / Robinhood API

- Three-tier AI prediction routing: AWS Bedrock (paid, complex analysis) → Local LLM (free, simple queries) → Rule-based fallback
- PDT compliance enforcement — max 3 day trades per 5 rolling business days for accounts under $25k
- Structured signal output with action, reasoning, confidence scores, target prices, and timeframes
- Dashboard-only mode when the brokerage connection is unavailable
- Safety defaults: `DRY_RUN=True` and `PAPER_TRADING=True` out of the box

[GitHub](https://github.com/zolty-mat/trade_bot)

---

## Card Price Tracker

A trading card game price tracker that monitors card prices across 10 major TCGs. Scrapes prices from TCGPlayer and eBay, stores historical data, and displays price trends on a web dashboard with Chart.js visualizations.

**Stack:** Python / Flask / PostgreSQL / Selenium / Chart.js

- Scrapes TCGPlayer via internal JSON APIs (no browser needed) and eBay via Selenium with a virtual display
- Supports 10 major trading card games with per-set and per-card tracking
- Web dashboard with interactive price charts and historical trend data
- Dual database backend — PostgreSQL in production, SQLite for local development
- Rate limiting with jitter to avoid detection

[GitHub](https://github.com/zolty-mat/cardboard)

---

## This Blog

The site you are reading. A Hugo static site using the PaperMod theme, deployed to AWS S3 and served via CloudFront CDN. Infrastructure is managed by Terraform — S3 bucket, CloudFront distribution, Route53 DNS, ACM certificate, and IAM policies are all defined as code.

**Stack:** Hugo / PaperMod / Terraform / S3 + CloudFront / GitHub Actions / AWS Bedrock

- Static site generation with Hugo, deployed via GitHub Actions on self-hosted runners
- Content generation pipeline using AWS Bedrock (Claude) for draft articles
- Amazon Associates integration with custom shortcodes for inline affiliate links and product cards
- Google Analytics (GA4) and Google AdSense integration
- Full CI/CD: push to main triggers build, S3 sync, and CloudFront cache invalidation

[GitHub](https://github.com/zolty-mat/zolty-blog)

---

## 3D Printing

A Bambu Lab P1S 3D printer used to fabricate custom parts for the homelab. Node enclosures with hexagonal mesh ventilation, SFP+ cable routing brackets, rack shelves, equipment mounts, and cable management clips — all printed in PETG for heat resistance near running hardware.

**Printer:** Bambu Lab P1S (enclosed, lidar bed leveling, direct drive)

- PETG functional parts: 265C nozzle / 80C bed, first layer +5C — significantly above advertised temperatures for stronger layer adhesion
- Custom enclosures for M920q nodes with directed airflow ventilation
- SFP+ cable routing brackets designed for the Mellanox ConnectX-3 installation
- Parametric designs in OpenSCAD for hardware-specific dimensions

**Blog posts:** [Bambu Lab P1S](/posts/2026-03-06-bambu-lab-p1s-3d-printing/) · [PETG Filament Settings](/posts/2026-03-08-petg-filament-settings/)
