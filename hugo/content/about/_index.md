---
title: "About"
date: 2025-02-21
author: "zolty"
description: "About zolty.systems - a homelab and infrastructure blog"
ShowToc: false
ShowBreadCrumbs: false
---

## Who is zolty?

I'm a systems engineer and homelab enthusiast who builds and maintains a production-grade Kubernetes cluster at home. This blog documents the journey -- the wins, the failures, and everything in between.

## What is this blog about?

This blog covers:

- **Homelab Infrastructure** -- Building and maintaining a multi-node k3s cluster on Proxmox VE
- **Kubernetes Deep Dives** -- Traefik, cert-manager, Longhorn, MetalLB, and more
- **DevOps & Automation** -- CI/CD with self-hosted GitHub Actions runners, Terraform, Ansible
- **Monitoring & Observability** -- Prometheus, Grafana, Loki, and custom alerting pipelines
- **Lessons Learned** -- Post-mortems and gotchas from running production workloads at home

## The Stack

The infrastructure behind this blog and the projects discussed here runs on:

- **3x Lenovo ThinkCentre M920q** mini PCs running Proxmox VE
- **K3s** (lightweight Kubernetes) in HA configuration with embedded etcd
- **Longhorn** for distributed block storage
- **Traefik** for ingress with automated TLS via Let's Encrypt
- **GitHub Actions** with self-hosted runners for CI/CD
- **Prometheus + Grafana + Loki** for full-stack observability

## Get in Touch

Find me on [GitHub](https://github.com/zolty-mat) or follow the blog via [RSS](/index.xml).
