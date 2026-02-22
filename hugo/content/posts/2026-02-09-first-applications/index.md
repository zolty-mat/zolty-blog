---
title: "Deploying First Applications: From Zero to Production in 24 Hours"
date: 2026-02-09T22:00:00-06:00
draft: false
author: "zolty"
description: "Day two of the cluster build: deploying Cardboard (TCG price tracker), Trade Bot (automated trading), a cluster dashboard, monitoring with Prometheus, and dev workspaces — all in one marathon session."
tags: ["kubernetes", "k3s", "deployment", "postgresql", "monitoring", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "First application deployments"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Day two of the cluster was a marathon. I deployed two full-stack applications (Cardboard TCG tracker and Trade Bot), set up PostgreSQL with Longhorn persistent storage, created a cluster dashboard, configured Prometheus service monitors, built a dev workspace for remote SSH, and scaled the ARC runners. By the end, the cluster was running real workloads and I had a proper development workflow.

## The Deployment Pattern

Before diving into the applications, I established a consistent deployment pattern that every service follows:

1. **Namespace isolation**: Each application gets its own namespace
2. **RBAC for CI/CD**: The ARC runner needs a RoleBinding in each namespace to deploy
3. **ECR for container images**: Private container registry via AWS ECR
4. **Helm or raw manifests**: Simple apps use kubectl manifests, complex ones use Helm
5. **ServiceMonitor**: Every app exposes metrics for Prometheus scraping

This pattern emerged organically during the day, driven mostly by failures — which I will get to.

## Cardboard: The First Real Application

Cardboard is a TCG (Trading Card Game) price tracker I built. It scrapes prices from TCGPlayer, stores them in PostgreSQL, and displays trends on a web dashboard. It was the natural first candidate for cluster deployment because it had a clear dependency chain: web frontend + API server + PostgreSQL database + scheduled price scraper.

### PostgreSQL on Kubernetes

Running databases on Kubernetes is controversial. The purists say "use managed services." But this is a homelab — I want to understand the failure modes, not outsource them.

I deployed PostgreSQL as a StatefulSet with a Longhorn PersistentVolumeClaim:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: cardboard
spec:
  serviceName: postgres
  replicas: 1
  template:
    spec:
      containers:
      - name: postgres
        image: postgres:16
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: longhorn
      resources:
        requests:
          storage: 10Gi
```

Longhorn replicates the volume across 2 nodes, so a node failure does not lose the database. Combined with the etcd snapshots and S3 backups I set up yesterday, the data has 3 layers of protection.

### The RBAC Deep Dive

This is where things got interesting. The ARC runner pods need permission to deploy into each application namespace. But Kubernetes RBAC has a subtle requirement: **you cannot grant permissions you do not have**. The runner's ClusterRole needs `escalate` and `bind` verbs to create RoleBindings:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: arc-runner-deploy
rules:
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["rolebindings", "roles"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "escalate", "bind"]
```

This burned about an hour of debugging. The error message from Kubernetes when you hit this is not helpful — it just says "forbidden" without explaining that the runner needs `escalate` to create a binding with more permissions than it currently has.

### CronJobs for Price Scraping

Cardboard needs to scrape prices periodically. I created a Kubernetes CronJob that runs every 6 hours:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: price-scraper
  namespace: cardboard
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: scraper
            image: <ECR_REPO>/cardboard-scraper:latest
          restartPolicy: OnFailure
```

The CronJob also needed its own ECR repository and RBAC permissions — another instance of the "runner needs all permissions it grants" lesson.

## Trade Bot: AI-Powered Trading on k3s

Trade Bot is an automated trading application that uses AWS Bedrock for market analysis. Deploying it introduced a new challenge: AWS IAM integration from within the cluster.

I created a reusable Terraform module for Bedrock IAM that provisions an IAM user with InvokeModel permissions scoped to Anthropic models. The credentials get stored as Kubernetes secrets (encrypted via SOPS in the repo).

The deployment itself is straightforward — a Flask web dashboard with a background trading engine. But getting Bedrock access working required multi-region IAM configuration since Bedrock model availability varies by region.

## Cluster Dashboard

With multiple applications running, I needed visibility. I built a lightweight cluster dashboard that shows:

- **Application status**: Health checks against each service endpoint
- **GitHub repositories**: Links to all project repos in the org
- **Quick links**: Grafana, Longhorn UI, Traefik dashboard

The dashboard is a simple static page served by nginx, with JavaScript health checks running client-side. Nothing fancy, but incredibly useful for at-a-glance cluster status.

## Monitoring: Prometheus + Grafana

The monitoring stack was already deployed as part of the cluster services (kube-prometheus-stack via Helm), but today I started actually using it:

### ServiceMonitor for Applications

Each application that exposes a `/metrics` endpoint gets a ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cardboard
  namespace: cardboard
spec:
  selector:
    matchLabels:
      app: cardboard
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
```

### GitHub Exporter

I deployed a GitHub Exporter that scrapes repository metrics (stars, forks, open issues, workflow run counts) and exports them to Prometheus. The accompanying Grafana dashboard shows CI/CD activity across all repositories in the organization.

### AlertManager → Slack

AlertManager sends notifications to a dedicated Slack channel. This was one of the easier integrations — AlertManager's webhook configuration just needs a Slack incoming webhook URL.

## Dev Workspace: SSH into the Cluster

One of the more useful things I set up today is a dev workspace — an SSH-accessible pod in the cluster that I can connect to from VS Code via Remote-SSH:

```bash
ssh -p 2222 debian@dev.internal.zolty.systems
```

The workspace pod runs a full Debian environment with all the tools I need: kubectl, helm, terraform, ansible, python, node. It mounts the kubeconfig as a secret so I can run cluster commands from inside the workspace.

This is a game-changer for development. Instead of configuring my local machine with all the right tool versions, I just SSH into the workspace and everything is pre-configured.

## Scaling Up

By midday, the worker nodes were feeling the pressure. I bumped each agent from 4 cores / 8GB to 6 cores / 12GB via Terraform:

```hcl
# terraform.tfvars
k3s_agents = [
  {
    name     = "k3s-agent-1"
    cores    = 6      # was 4
    memory   = 12288  # was 8192
    # ...
  },
]
```

I also scaled the ARC runner deployment from 3 to 5 pods. With multiple CI pipelines running concurrently, 3 runners was causing queuing delays.

## End of Day Stats

| Metric | Count |
|--------|-------|
| Deployed applications | 4 (Cardboard, Trade Bot, Dashboard, Dev Workspace) |
| PostgreSQL databases | 2 |
| CronJobs | 1 (price scraper) |
| ServiceMonitors | 3 |
| Namespaces | 8 |
| GitHub Actions runners | 5 |
| RBAC bugs fixed | 4 |

## Lessons Learned

1. **RBAC `escalate` and `bind` verbs are essential** for any service account that creates RoleBindings. The Kubernetes documentation buries this, and the error messages are unhelpful.
2. **PostgreSQL on Longhorn works well** for homelab workloads. The Longhorn replication gives me confidence that a node failure will not cause data loss.
3. **Dev workspaces are worth the effort** — having a consistent, pre-configured development environment accessible via SSH eliminates "works on my machine" problems.
4. **Scale workers early.** The default 4c/8GB was tight even with just a few applications. Going to 6c/12GB gave much better headroom.
5. **ECR per service** keeps container images organized and access controlled. Each service has its own repository with lifecycle policies to clean up old images.

Day two was exhausting but productive. The cluster is now doing real work. Tomorrow: Home Assistant and hardware monitoring.
