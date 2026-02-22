---
title: "Self-Hosted CI/CD: Running GitHub Actions Runners on k3s"
date: 2026-02-12T20:00:00-06:00
draft: false
author: "zolty"
description: "A deep dive into GitHub Actions Runner Controller (ARC) on k3s — from initial setup to scaling, RBAC configuration, and all the gotchas I hit along the way."
tags: ["github-actions", "cicd", "kubernetes", "arc", "homelab"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "Self-hosted CI/CD"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Running self-hosted GitHub Actions runners on the same k3s cluster they deploy to is a powerful pattern. GitHub Actions Runner Controller (ARC) manages runner pods as Kubernetes resources, scaling them based on workflow demand. This post covers the full setup, the RBAC model that makes it work, and every gotcha I encountered.

## Why Self-Hosted Runners?

GitHub-hosted runners are convenient but have limitations:

- **Cost**: Free tier gives 2,000 minutes/month. With 5+ repositories doing multiple deploys per day, that burns fast.
- **Speed**: GitHub-hosted runners are shared infrastructure. Cold starts take 20-30 seconds, and you are competing with other users.
- **Access**: GitHub-hosted runners cannot reach my private cluster network. Every deployment would need a VPN or tunnel.
- **Control**: I want to install whatever tools I need (kubectl, helm, terraform, ansible) without Docker layer caching tricks.

Self-hosted runners solve all of these: they run inside the cluster, have direct network access to all services, pre-configured tools, and no usage limits.

> **No homelab?** You can run self-hosted ARC runners on [DigitalOcean Kubernetes (DOKS)](https://www.digitalocean.com/?refcode=b9012919f7ff&utm_campaign=Referral_Invite&utm_medium=Referral_Program&utm_source=badge) — a managed cluster with $200 in free credit is enough to run runners for months.

## ARC Architecture

GitHub Actions Runner Controller (ARC) deploys runners as Kubernetes pods:

```
┌─────────────────────────────────────────┐
│              k3s Cluster                 │
│                                          │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │ ARC          │  │ Runner Pods      │ │
│  │ Controller   │──│  runner-1        │ │
│  │ (watches     │  │  runner-2        │ │
│  │  GitHub API) │  │  runner-3        │ │
│  │              │  │  runner-4        │ │
│  │              │  │  runner-5        │ │
│  └──────────────┘  └──────────────────┘ │
│                                          │
│  GitHub webhook ─► ARC scales runners    │
└─────────────────────────────────────────┘
```

ARC watches the GitHub API for pending workflow runs and creates runner pods on demand. When a workflow starts, ARC assigns it to an available runner pod. When the workflow finishes, the pod is recycled.

## Installation

ARC installs via Helm:

```bash
helm repo add actions-runner-controller https://actions-runner-controller.github.io/actions-runner-controller
helm install arc actions-runner-controller/actions-runner-controller \
  --namespace arc-system \
  --create-namespace \
  --set authSecret.create=true \
  --set authSecret.github_token=$GITHUB_PAT
```

Then create a RunnerDeployment:

```yaml
apiVersion: actions.summerwind.dev/v1alpha1
kind: RunnerDeployment
metadata:
  name: k3s-runners
  namespace: arc-system
spec:
  replicas: 5
  template:
    spec:
      repository: zolty-mat
      organization: zolty-mat
      labels:
        - self-hosted
        - k3s
        - linux
        - amd64
```

## The Labels Gotcha

This is the first thing that bit me. The `labels` field in ARC's RunnerDeployment **replaces** all default labels entirely. If you specify:

```yaml
labels:
  - k3s
  - linux
  - amd64
```

The runner will NOT have the `self-hosted` label. Your workflows with `runs-on: [self-hosted, k3s, linux, amd64]` will never match.

Always explicitly include `self-hosted`:

```yaml
labels:
  - self-hosted
  - k3s
  - linux
  - amd64
```

This cost me an hour of staring at workflows stuck in "Queued" state with no obvious error message.

## The RBAC Model

This is the most complex part of the setup. The runner pods need permission to deploy into multiple namespaces. The permission model has three layers:

### 1. ClusterRole for Common Resources

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: arc-runner-deploy
rules:
- apiGroups: [""]
  resources: ["namespaces", "services", "configmaps", "secrets", "persistentvolumeclaims"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "replicasets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: ["batch"]
  resources: ["jobs", "cronjobs"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles", "rolebindings"]
  verbs: ["get", "list", "create", "update", "patch", "delete", "escalate", "bind"]
```

### 2. Per-Namespace RoleBinding

Each application namespace gets a RoleBinding granting the runner service account access:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: arc-runner-deploy
  namespace: cardboard  # Repeat for each app namespace
subjects:
- kind: ServiceAccount
  name: arc-runner
  namespace: arc-system
roleRef:
  kind: ClusterRole
  name: arc-runner-deploy
  apiGroup: rbac.authorization.k8s.io
```

### 3. The `escalate` and `bind` Requirement

The critical piece: if your workflow creates RoleBindings (e.g., deploying an app that needs its own RBAC), the runner's ClusterRole needs `escalate` and `bind` verbs on the `rolebindings` resource. Without these, Kubernetes prevents the runner from creating bindings with permissions the runner itself does not have.

The error you get without these verbs is a generic "forbidden" that does not mention escalate or bind. Trust me on this one.

## Workflow Configuration

My workflows use this runner configuration:

```yaml
jobs:
  deploy:
    runs-on: [self-hosted, k3s, linux, amd64]
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to cluster
        run: |
          kubectl apply -f kubernetes/
```

The runners have `kubectl`, `helm`, and `aws` CLI pre-installed. The kubeconfig is mounted as a service account token — no credentials to manage.

## Scaling

I started with 3 runners and quickly moved to 5. The scaling decision depends on workflow patterns:

- **3 runners**: Fine for sequential workflows. Queues if multiple repos push simultaneously.
- **5 runners**: Handles most concurrent scenarios. Rarely see queuing.
- **Auto-scaling**: ARC supports HorizontalRunnerAutoscaler, but with 5+ repositories, a fixed pool of 5 runners has been sufficient.

Each runner pod costs about 500m CPU and 512Mi memory. Five runners use 2.5 cores and 2.5GB — modest for the convenience.

## Architecture Constraints: amd64 Only

My cluster has a mix of amd64 and arm64 nodes. ARC runners must run on amd64 nodes because most of the tooling (kubectl, helm, AWS CLI, Docker-in-Docker) expects amd64 binaries. I constrain runners to amd64 nodes:

```yaml
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64
```

This was another debugging session. Without the nodeSelector, a runner occasionally landed on the arm64 node and every workflow would fail with cryptic exec format errors.

## Docker-in-Docker

Some workflows need to build container images. ARC supports Docker-in-Docker (DinD) as a sidecar:

```yaml
spec:
  template:
    spec:
      containers:
      - name: runner
        image: summerwind/actions-runner:latest
      - name: dind
        image: docker:dind
        securityContext:
          privileged: true
```

The DinD sidecar requires privileged mode, which means the Pod Security Standard for the runner namespace must be set to `privileged`. This is a security tradeoff — the runners are trusted infrastructure, so privileged mode is acceptable.

## Monitoring Runners

I track runner utilization through the GitHub Exporter mentioned in a previous post. Key metrics:

- **Workflow queue time**: How long workflows wait for a runner
- **Workflow run duration**: End-to-end execution time
- **Runner pod restarts**: Indicator of instability
- **Runner CPU/memory**: Whether we need to scale up individual runner resources

## Lessons Learned

1. **ARC labels replace defaults** — always include `self-hosted` explicitly.
2. **RBAC for CI/CD is the hardest part** — plan your permission model before deploying. The `escalate`/`bind` requirement is not obvious.
3. **NodeSelector for amd64 is mandatory** in mixed-architecture clusters.
4. **5 runners is the sweet spot** for a homelab with 5-10 active repositories.
5. **DinD requires privileged mode** — accept the security tradeoff for trusted infrastructure.
6. **Self-hosted runners are faster** than GitHub-hosted — cold start is near-zero since the pods are pre-warmed and tools are pre-installed.

Self-hosted CI/CD is one of the best investments I have made in this cluster. The feedback loop from push-to-deploy is under 2 minutes for most services, and I never worry about runner minutes.
