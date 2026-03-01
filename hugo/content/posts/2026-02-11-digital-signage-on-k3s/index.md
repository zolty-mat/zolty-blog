---
title: "Migrating a Full-Stack App to Kubernetes: Digital Signage on k3s"
date: 2026-02-11T19:00:00-06:00
draft: false
author: "zolty"
description: "Taking an Angular SPA and 7 Flask microservices from local development to Kubernetes — covering MQTT brokers, multi-service deployments, and the joys of container networking."
tags: ["kubernetes", "angular", "flask", "microservices", "mqtt", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "Digital Signage deployment"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Today I migrated Digital Signage — an Angular SPA backed by 7 Flask microservices, an MQTT broker, and PostgreSQL — from a development environment to the k3s cluster. This is the most complex application on the cluster so far, and deploying it taught me a lot about managing multi-service applications in Kubernetes.

## The Application

Digital Signage started as a side project back in May 2025, designed to drive informational displays on {{< amzn search="Raspberry Pi 4" >}}Raspberry Pi{{< /amzn >}} kiosk devices. It evolved over the months into a surprisingly complex system:


**Frontend:**
- Angular SPA with real-time data updates
- Calendar integration, weather widgets, chore management
- IoT device control via dashboard buttons

**Backend (7 Flask microservices):**
- Authentication service
- Calendar sync service
- Weather data aggregator
- Chore tracker
- IoT device controller
- Content management API
- Dashboard configuration service

**Infrastructure:**
- Mosquitto MQTT broker for real-time communication between services and displays
- PostgreSQL database shared across services
- Redis for session caching

## The Deployment Strategy

With 7 microservices, a frontend, an MQTT broker, and two databases to deploy, I needed a systematic approach. Each component got its own Kubernetes manifest:

```
kubernetes/digital-signage/
├── namespace.yaml
├── postgres/
│   ├── statefulset.yaml
│   ├── service.yaml
│   └── pvc.yaml
├── redis/
│   ├── deployment.yaml
│   └── service.yaml
├── mqtt/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── configmap.yaml
├── services/
│   ├── auth-service.yaml
│   ├── calendar-service.yaml
│   ├── weather-service.yaml
│   ├── chore-service.yaml
│   ├── iot-service.yaml
│   ├── content-service.yaml
│   └── dashboard-service.yaml
├── frontend/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
└── rbac.yaml
```

{{< ad >}}

## MQTT on Kubernetes

The MQTT broker (Eclipse Mosquitto) is central to the architecture — all microservices publish state changes to MQTT topics, and the Angular frontend subscribes via WebSockets. Running MQTT on Kubernetes is straightforward:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mosquitto
  namespace: digital-signage
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: mosquitto
        image: eclipse-mosquitto:2
        ports:
        - containerPort: 1883    # MQTT
        - containerPort: 9001    # WebSocket
        volumeMounts:
        - name: config
          mountPath: /mosquitto/config
      volumes:
      - name: config
        configMap:
          name: mosquitto-config
```

The key configuration is enabling WebSocket support in `mosquitto.conf`:

```
listener 1883
protocol mqtt

listener 9001
protocol websockets

allow_anonymous true
```

Internal services connect via `mqtt://mosquitto.digital-signage.svc.cluster.local:1883`. The Angular frontend connects via `wss://signage.zolty.systems/mqtt`, with Traefik proxying WebSocket connections to port 9001.

## Service-to-Service Communication

With 7 microservices, service discovery matters. Kubernetes makes this easy — each service gets a cluster DNS name:

```python
# In any Flask service
MQTT_BROKER = "mosquitto.digital-signage.svc.cluster.local"
DB_HOST = "postgres.digital-signage.svc.cluster.local"
REDIS_HOST = "redis.digital-signage.svc.cluster.local"
AUTH_SERVICE = "http://auth-service.digital-signage.svc.cluster.local:5000"
```

No service mesh, no Consul, no external service registry. Kubernetes built-in DNS is sufficient for this scale.

## Database Sharing Considerations

All 7 microservices share a single PostgreSQL instance, each using its own database within the server. This is a pragmatic choice for a homelab:

**Pros:**
- Single StatefulSet to manage
- Single backup target
- Simple resource management

**Cons:**
- Noisy neighbor risk (one service can starve others)
- Schema migrations require coordination
- No per-service resource limits on the database level

At homelab scale, the simplicity wins. If any service needed isolation, I could split it to its own PostgreSQL instance later.

## Deploying 7 Services Without Going Crazy

Writing 7 deployment manifests by hand is tedious and error-prone. I established a template pattern:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${SERVICE_NAME}
  namespace: digital-signage
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${SERVICE_NAME}
  template:
    metadata:
      labels:
        app: ${SERVICE_NAME}
    spec:
      containers:
      - name: ${SERVICE_NAME}
        image: ${ECR_REPO}/${SERVICE_NAME}:latest
        ports:
        - containerPort: 5000
        envFrom:
        - secretRef:
            name: digital-signage-secrets
        env:
        - name: SERVICE_NAME
          value: "${SERVICE_NAME}"
```

Each service uses the same base image (Python 3.12 + Flask), just with different application code. The `envFrom` section injects shared secrets (database credentials, API keys) from a single Kubernetes Secret.

## The CI/CD Pipeline

The GitHub Actions workflow for Digital Signage is more complex than the others because it builds 8 container images (7 services + frontend):

```yaml
strategy:
  matrix:
    service:
      - auth-service
      - calendar-service
      - weather-service
      - chore-service
      - iot-service
      - content-service
      - dashboard-service
      - frontend
```

The matrix strategy builds all 8 images in parallel on the self-hosted runners. Each image gets pushed to its own ECR repository, then the deployment manifests are applied.

Total build time: about 4 minutes for all 8 images plus deployment. Not bad for a self-hosted cluster.

## The Display Endpoints

The actual {{< amzn search="Raspberry Pi 4" >}}Raspberry Pi{{< /amzn >}} displays connect to the Angular SPA and receive updates in real-time via MQTT WebSockets. The architecture works well for a kiosk use case:


1. Display loads the Angular app from `signage.zolty.systems`
2. App connects to MQTT broker via WebSocket
3. Backend services publish updates (weather, calendar events, chore completions)
4. Angular receives updates and re-renders affected widgets
5. No polling, no page refreshes — true real-time updates

## Lessons Learned

1. **Multi-service applications benefit from a namespace-per-app pattern.** All 7 services, the MQTT broker, and the databases share one namespace with shared secrets. Service discovery is clean and RBAC is simple.
2. **MQTT + WebSockets through Kubernetes ingress works seamlessly** with Traefik. No special configuration needed beyond the standard WebSocket support.
3. **Shared PostgreSQL is fine at homelab scale.** The operational simplicity of one database server outweighs the theoretical benefits of per-service databases — at this scale.
4. **Matrix builds in GitHub Actions** are the right way to handle multi-service repos. Building 8 images in parallel cuts CI time dramatically.

The cluster now has its most complex application running. Tomorrow: self-hosted CI/CD deep dive.
