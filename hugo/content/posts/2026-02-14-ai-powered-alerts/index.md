---
title: "Building an AI-Powered Alert System with AWS Bedrock"
date: 2026-02-14T20:00:00-06:00
draft: false
author: "zolty"
description: "How I built an AI alert responder that analyzes Prometheus alerts using AWS Bedrock and suggests remediation actions directly in Slack, plus multi-user dev workspaces on k3s."
tags: ["aws-bedrock", "ai", "monitoring", "slack", "prometheus", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "AI-powered alert analysis"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Today I deployed two significant additions to the cluster: an AI-powered Alert Responder that uses AWS Bedrock (Amazon Nova Micro) to analyze Prometheus alerts and post remediation suggestions to Slack, and a multi-user dev workspace with per-user environments. I also hardened the cluster by constraining all workloads to the correct architecture nodes and fixing arm64 scheduling issues.

## The Alert Responder

Running 13+ applications on a homelab cluster means alerts fire regularly. Most are straightforward — high memory, restart loops, certificate expiry warnings — but analyzing each one, determining root cause, and knowing the right remediation command gets tedious, especially at 2 AM.

Enter the Alert Responder: an AI agent that receives AlertManager webhooks, enriches them with cluster context, and posts analysis + suggested remediation to Slack.

### Architecture

```
AlertManager ──webhook──► Alert Responder ──analysis──► Slack
                               │
                          AWS Bedrock
                          (Nova Micro)
                               │
                          kubectl context
                          (pod logs, events,
                           node status)
```

### How It Works

1. **AlertManager fires** and sends a webhook to the Alert Responder service
2. **Context enrichment**: The responder queries the Kubernetes API for relevant context — pod logs, recent events, node conditions, resource utilization
3. **AI analysis**: The enriched alert + context is sent to AWS Bedrock (Amazon Nova Micro) with a system prompt that understands our cluster architecture
4. **Slack notification**: The analysis, severity assessment, and suggested remediation commands are posted to a dedicated Slack channel

### The System Prompt

The system prompt is crucial. It encodes knowledge about our specific cluster:

```
You are an SRE assistant for a k3s homelab cluster running on Proxmox VMs.
The cluster has 3 server nodes and 3+ agent nodes running on Lenovo M920q hardware.
Storage: Longhorn distributed storage with 2x replication.
Ingress: Traefik with cert-manager for TLS.
Monitoring: kube-prometheus-stack.

When analyzing alerts, consider:
- Node resource pressure may indicate VM resource limits need adjustment
- Longhorn volume issues may require checking underlying disk health
- Certificate alerts should check cert-manager logs and DNS solver status
- Pod restart loops should check for OOMKills, CrashLoopBackOff, image pull errors

Provide specific kubectl commands for investigation and remediation.
```

### Why Nova Micro?

I chose Amazon Nova Micro over larger models for several reasons:

- **Cost**: At ~$0.035 per 1M input tokens, it costs almost nothing to run. Processing 50 alerts per day costs less than $0.01/month.
- **Speed**: Responses come back in under 2 seconds, which matters for real-time alerting.
- **Capability**: For alert analysis with context, a smaller model with good instructions performs well. This is not a task that needs frontier reasoning ability.

### Slack Socket Mode

The Alert Responder also supports Slack Socket Mode for interactive remediation. When the AI suggests a command, a Slack user can click a button to execute it directly:

```
🔴 Alert: PodCrashLoopBackOff
Pod: cardboard/price-scraper-28487520-abc12
Status: CrashLoopBackOff (5 restarts in 10 min)

Analysis: The price scraper CronJob pod is failing due to an
OOMKilled event. Current memory limit is 256Mi but the scraper
is consuming ~380Mi during peak scraping.

Suggested Fix:
[Increase memory limit to 512Mi]  [View pod logs]  [Describe pod]
```

Clicking "Increase memory limit" triggers a kubectl patch command via the responder's Kubernetes API access. This is controlled by RBAC — the responder's service account only has access to specific resources in specific namespaces.

## Multi-User Dev Workspace

The dev workspace I set up on day two evolved into a proper multi-user environment:

### Per-User Configuration

Each user gets their own:
- Home directory with persistent storage
- Zsh shell with oh-my-zsh (agnoster theme)
- Custom `.zshrc` with cluster aliases
- SSH key pair for GitHub access
- kubeconfig scoped to their authorized namespaces

### Pre-Installed Tooling

The workspace image includes everything needed for cluster operations:

```dockerfile
RUN apt-get install -y \
    kubectl helm terraform ansible \
    python3 python3-pip \
    nodejs npm \
    git curl wget jq yq \
    vim nano htop \
    openssh-server
```

### Layout Management

Different users need access to different tools. The workspace supports per-user layouts defined in a ConfigMap:

```yaml
users:
  admin:
    namespaces: ["*"]
    tools: ["kubectl", "helm", "terraform", "ansible"]
  developer:
    namespaces: ["cardboard", "trade-bot"]
    tools: ["kubectl", "helm"]
```

## The arm64 Scheduling Problem

Today was the day I finally fixed a recurring issue: workloads being scheduled on the arm64 node (Lima, a Mac Mini running k3s as an agent) and failing with exec format errors.

The root cause: not every deployment had a `nodeSelector` or `nodeAffinity` for `kubernetes.io/arch: amd64`. When the scheduler placed a pod on the arm64 node, it would pull the amd64 image and crash immediately.

The fix was systematic — I went through every deployment, StatefulSet, CronJob, and DaemonSet and added architecture constraints:

```yaml
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64
```

For CronJobs, which create Job objects that create Pods, the selector needs to be in the nested pod template:

```yaml
spec:
  jobTemplate:
    spec:
      template:
        spec:
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
              - matchExpressions:
                - key: kubernetes.io/arch
                  operator: In
                  values: ["amd64"]
```

I also documented this as a permanent lesson: in mixed-architecture clusters, every workload needs an explicit architecture constraint unless the container image is verified multi-arch.

## UnPoller 429 Death Spiral

An interesting production issue today: UnPoller (a UniFi metrics exporter) started hitting 429 (rate limit) responses from the UniFi controller. When it got rate-limited, it retried aggressively, which caused more 429s, which caused more retries — a classic death spiral.

The fix: configured exponential backoff on the UnPoller polling interval and added a circuit breaker that pauses polling for 5 minutes after 3 consecutive 429 responses.

## Lessons Learned

1. **Small AI models work great for operational tasks.** Alert analysis does not need GPT-4 — a well-prompted Nova Micro with good context produces actionable remediation suggestions at near-zero cost.
2. **Interactive Slack bots need careful RBAC scoping.** The ability to execute kubectl commands from Slack is powerful but dangerous. Scope the service account to only what is needed.
3. **Fix arm64 scheduling once and for all.** Do not play whack-a-mole with individual deployments. Audit everything, add nodeSelectors to everything, document the pattern.
4. **Rate limit handling needs to be explicit.** Never assume an upstream API is unlimited. Build in backoff and circuit breaking from the start.

The cluster is now at 7 deployed applications with AI-powered operations. Tomorrow: documenting operational lessons.
