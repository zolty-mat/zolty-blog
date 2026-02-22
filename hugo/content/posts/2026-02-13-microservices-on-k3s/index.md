---
title: "Deploying a Microservices Architecture on k3s"
date: 2026-02-13T21:00:00-06:00
draft: false
author: "zolty"
description: "Lessons from deploying a Vue.js frontend with 7 FastAPI backend services, NATS messaging, PostgreSQL, and Redis on a homelab k3s cluster."
tags: ["kubernetes", "microservices", "fastapi", "nats", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "Microservices architecture"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Today I deployed the most architecturally complex application on the cluster: a video service platform with a Vue.js frontend, 7 FastAPI backend microservices, NATS for messaging, PostgreSQL for persistence, and Redis for caching. This post covers the deployment patterns for NATS-based microservices on k3s and the RBAC fixes needed for Helm-based deployments.

## The Application Architecture

The video service platform is a full microservices stack:

```
┌──────────────┐
│   Vue.js     │  Frontend SPA
│   Frontend   │
└──────┬───────┘
       │ HTTP/REST
┌──────┴───────────────────────────────────────┐
│              API Gateway                      │
└──────┬───────────────────────────────────────┘
       │
┌──────┴───────────────────────────────────────┐
│           FastAPI Microservices                │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│  │Auth │ │Video│ │Media│ │Queue│           │
│  └─────┘ └─────┘ └─────┘ └─────┘           │
│  ┌─────┐ ┌─────┐ ┌─────┐                    │
│  │Stats│ │User │ │Notif│                    │
│  └─────┘ └─────┘ └─────┘                    │
└──────────────────────────────────────────────┘
       │              │              │
  ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
  │PostgreSQL│   │  NATS   │   │  Redis  │
  └─────────┘   └─────────┘   └─────────┘
```

Seven FastAPI services communicate via NATS for asynchronous messaging and Redis for shared state. PostgreSQL handles persistent data.

## NATS on Kubernetes

NATS is a lightweight, high-performance messaging system. It is a natural fit for Kubernetes because it is designed to be ephemeral and stateless (for core NATS; JetStream adds persistence).

I deployed NATS using the official Helm chart:

```bash
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm install nats nats/nats \
  --namespace video-service \
  --set nats.jetstream.enabled=true \
  --set nats.jetstream.memStorage.size=256Mi
```

JetStream is enabled for guaranteed message delivery — I do not want to lose processing requests because a consumer was temporarily down.

### Service Discovery with NATS

Each FastAPI service connects to NATS using the Kubernetes service DNS:

```python
import nats

async def connect():
    nc = await nats.connect("nats://nats.video-service.svc.cluster.local:4222")

    # Subscribe to video processing requests
    sub = await nc.subscribe("video.process")
    async for msg in sub.messages:
        await handle_processing(msg)
```

NATS handles the pub/sub routing. Services do not need to know about each other — they just publish to and subscribe from named subjects.

## Helm Deployment and RBAC Issues

I used Helm for the overall deployment. This introduced a new RBAC requirement: Helm's `--wait` flag needs to watch ReplicaSets and Events to determine if a deployment succeeded.

The ARC runner's ClusterRole needed these additions:

```yaml
- apiGroups: ["apps"]
  resources: ["replicasets"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
```

Without `watch` on events and replicasets, `helm install --wait` hangs indefinitely because it cannot observe the rollout status. The deployment actually succeeds, but Helm does not know about it.

## FastAPI Service Template

All 7 services follow the same deployment template:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.serviceName }}
  namespace: video-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.serviceName }}
  template:
    metadata:
      labels:
        app: {{ .Values.serviceName }}
    spec:
      containers:
      - name: {{ .Values.serviceName }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
        ports:
        - containerPort: 8000
        env:
        - name: NATS_URL
          value: "nats://nats.video-service.svc.cluster.local:4222"
        - name: REDIS_URL
          value: "redis://redis.video-service.svc.cluster.local:6379"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: video-service-secrets
              key: database-url
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

The uniformity is intentional — all services use the same runtime (Python 3.12 + FastAPI + Uvicorn), same port (8000), same dependency pattern (NATS + Redis + PostgreSQL). This consistency makes operations and debugging much simpler.

## Environment Variable Ordering

A subtle bug I hit: the `DATABASE_URL` environment variable references `DB_USER` and `DB_PASS`, which are defined as separate environment variables. In Kubernetes, environment variable ordering matters — if `DATABASE_URL` is defined before `DB_USER`, the interpolation fails.

```yaml
# Wrong order (DATABASE_URL cannot reference DB_USER yet):
env:
- name: DATABASE_URL
  value: "postgresql://$(DB_USER):$(DB_PASS)@postgres:5432/mydb"
- name: DB_USER
  valueFrom:
    secretKeyRef: ...
- name: DB_PASS
  valueFrom:
    secretKeyRef: ...

# Correct order:
env:
- name: DB_USER
  valueFrom:
    secretKeyRef: ...
- name: DB_PASS
  valueFrom:
    secretKeyRef: ...
- name: DATABASE_URL
  value: "postgresql://$(DB_USER):$(DB_PASS)@postgres:5432/mydb"
```

This is documented in the Kubernetes specification, but it is easy to overlook when you have 20+ environment variables.

## Redis for Shared State

Redis serves two purposes in this architecture:

1. **Session caching**: User sessions are stored in Redis so any service instance can validate them
2. **Rate limiting**: API rate limits are tracked in Redis using sorted sets

The Redis deployment is simple — a single replica with a small PVC for persistence:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: video-service
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        args: ["--appendonly", "yes"]
        volumeMounts:
        - name: data
          mountPath: /data
```

## CI/CD for Multi-Service Repos

The CI pipeline builds all 7 service images using a matrix strategy (same pattern as Digital Signage). Each push triggers:

1. Matrix build of changed services (only rebuilds what changed)
2. Push to ECR
3. Helm upgrade with `--wait`
4. Health check against each service endpoint

Total pipeline time: ~5 minutes.

## Lessons Learned

1. **NATS is excellent for Kubernetes microservices.** Lightweight, fast, and the Helm chart makes deployment trivial. JetStream adds the reliability guarantees needed for production use.
2. **Helm `--wait` requires `watch` verbs** on replicasets and events in the deployer's RBAC. Without these, deployments appear to hang.
3. **Environment variable ordering matters** in Kubernetes pod specs. Variables that reference other variables must be defined after their dependencies.
4. **Template your microservice deployments.** When all services follow the same pattern, Helm values files become the only thing that varies between services.

Five applications now running on the cluster, with two more complex microservice stacks deployed. The cluster is handling real workloads and the CI/CD pipeline is humming along.
