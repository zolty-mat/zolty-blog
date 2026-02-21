---
title: "Welcome to zolty.systems"
date: 2025-02-21
draft: false
author: "zolty"
description: "Introducing zolty.systems -- a blog about homelab infrastructure, Kubernetes, and the lessons learned from running production workloads at home."
tags: ["homelab", "kubernetes", "meta"]
categories: ["meta"]
cover:
  image: ""
  alt: ""
  caption: ""
ShowToc: true
TocOpen: true
---

## TL;DR

This is zolty.systems -- a technical blog about building and running a production-grade Kubernetes homelab. Expect deep dives into k3s, Proxmox, networking, monitoring, CI/CD, and all the things that break along the way.

## Why Another Homelab Blog?

Because every homelab is different, and every failure teaches something new.

I've been running a multi-node k3s cluster on repurposed mini PCs for a while now. What started as a "let me just run a few containers" experiment has evolved into a full production-grade platform with:

- High-availability Kubernetes control plane
- Distributed block storage
- Automated TLS certificate management
- Self-hosted CI/CD runners
- Full observability stack (metrics, logs, alerts)
- Automated remediation pipelines

Along the way, I've hit every possible failure mode: networking issues that took days to debug, storage deadlocks that required rethinking deployment strategies, DNS configurations that silently broke half the cluster, and LACP bonds that bricked a NAS.

This blog exists to document those experiences -- not just the polished end result, but the messy debugging sessions and the "oh, that's why" moments.

## What to Expect

### Infrastructure Deep Dives

Step-by-step guides for building and configuring homelab infrastructure. Not the "just run this script" kind -- the "here's why each setting matters" kind.

### Kubernetes Patterns and Anti-Patterns

Real-world lessons from running k3s in production. What works, what doesn't, and what will silently break at 3 AM.

### Monitoring and Observability

How to know when things break before your users do (or in my case, before I notice the dashboard is down).

### Post-Mortems

Honest write-ups of what went wrong and how it got fixed. The best learning comes from failure.

## The Tech Stack

This blog itself is a product of the homelab:

- **Hugo** for static site generation
- **AWS CloudFront + S3** for global CDN delivery
- **GitHub Actions** running on self-hosted k3s runners for CI/CD
- **AWS Bedrock** for AI-assisted content drafting
- **Terraform** for infrastructure management

Every piece of infrastructure is codified, automated, and version-controlled. No ClickOps allowed.

## Stay Tuned

Subscribe via [RSS](/index.xml) or check back regularly. There's a lot to cover.
