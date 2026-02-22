---
title: "OpenClaw on k3s: Replacing Open WebUI with a Lighter AI Gateway"
date: 2026-03-14T20:00:00-06:00
draft: false
author: "zolty"
description: "How I replaced Open WebUI with OpenClaw -- a Node.js AI assistant gateway that is lighter, supports multiple channels, and deploys cleanly on Kubernetes with a custom Docker image."
tags: ["openclaw", "ai", "kubernetes", "llm", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "OpenClaw AI gateway on k3s"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

I replaced Open WebUI with OpenClaw -- a lighter, WebSocket-based AI assistant gateway that installs from npm, supports multiple chat channels (web, Telegram, Discord, WhatsApp), and deploys on k3s as a single Deployment with a custom Docker image. The primary model provider is Anthropic's direct API (Claude Sonnet 4.5), with LiteLLM/Bedrock as a fallback. The biggest deployment lesson: OpenClaw binds to loopback by default, which makes it invisible to Kubernetes Services and health probes. The fix is `--bind lan`, which requires a gateway token for authentication.

## Why Replace Open WebUI

Open WebUI, covered in the [Self-Hosted AI Chat](/posts/2026-03-04-private-ai-chat/) post, worked. It provided a clean chat interface, conversation history, and model selection. But after a few weeks of running it on the cluster, several friction points became clear.

**The StatefulSet problem.** Open WebUI deploys as a StatefulSet, not a Deployment. StatefulSets only support `RollingUpdate` and `OnDelete` update strategies -- not `Recreate`. When I needed to update the pod spec, `OnDelete` meant manually deleting the pod and waiting for it to be recreated. Every other application on the cluster uses `Recreate` strategy on Deployments, which is simple and predictable.

**The sentence transformer download.** On first boot, Open WebUI downloads a 657MB sentence transformer model for its RAG features. On a homelab with limited bandwidth and NVMe storage, this is a nontrivial initialization penalty. If the pod restarts on a different node, it downloads again unless the PVC follows it.

**The Helm chart complexity.** The Open WebUI Helm chart has many knobs -- Ollama URLs, Redis for WebSocket sessions, environment variables for auth, and persistence configuration. It works once configured, but it is a lot of moving parts for what is fundamentally a chat interface.

OpenClaw solves all of these:

- **npm package, not a Helm chart.** Install with `npm install -g openclaw@latest`. The entire gateway is a single Node.js process.
- **Deployment, not StatefulSet.** Standard Kubernetes Deployment with `Recreate` strategy. Update the image, `kubectl rollout restart`, done.
- **WebSocket-native.** Real-time streaming responses without polling. The chat experience is noticeably smoother.
- **Multi-channel support.** WebChat is built in, but OpenClaw also supports Telegram, Discord, and WhatsApp channels. One gateway, multiple interfaces.
- **Agent features built in.** Web search, web page fetching, code execution ("elevated tools"), and a canvas feature for document editing -- all included without plugins or extensions.
- **Lightweight.** The container image is under 300MB. No sentence transformer download. Startup takes seconds, not minutes.

## Building the Docker Image

OpenClaw does not publish an official Docker image. It is distributed as an npm package, so you need to build a custom container image. This was the first gotcha.

The Dockerfile is straightforward:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y python3 make g++ libopus-dev && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest
USER 1000
CMD ["openclaw", "gateway", "--port", "18789", "--bind", "lan", "--allow-unconfigured"]
```

Each layer has a purpose:

- **`node:22-bookworm-slim`** -- Debian-based Node.js runtime. The slim variant keeps the image small while providing the system libraries that native modules need.
- **`python3 make g++ libopus-dev`** -- Native compilation dependencies. OpenClaw depends on `@discordjs/opus` for Discord voice support, which uses node-gyp to compile a C++ binding against libopus. Without these packages, `npm install` fails during the native module build.
- **`npm install -g openclaw@latest`** -- Installs OpenClaw globally so the `openclaw` command is available in PATH.
- **`USER 1000`** -- Run as a non-root user. The Kubernetes deployment spec sets `runAsUser: 1000` and `runAsGroup: 1000` to match.
- **`CMD`** -- The gateway command with `--port 18789`, `--bind lan` (required for Kubernetes), and `--allow-unconfigured` (allows initial access to the Control UI without pre-configuring models).

### CI/CD Pipeline

The ECR repository is managed by Terraform as part of the cluster infrastructure module. GitHub Actions workflows on self-hosted runners build and push the image:

```yaml
- name: Build and push OpenClaw image
  run: |
    aws ecr get-login-password --region us-east-1 | \
      docker login --username AWS --password-stdin $ECR_REGISTRY
    docker build -t $ECR_REGISTRY/k3s-homelab/openclaw:latest .
    docker push $ECR_REGISTRY/k3s-homelab/openclaw:latest
```

The self-hosted ARC runners have Docker-in-Docker configured, so container builds run on the cluster itself. No external CI service needed.

{{< ad >}}

## Kubernetes Deployment

The deployment has five Kubernetes resources: a Secret, a ConfigMap, a PVC, a Deployment, and a Service.

### Secret

Two sensitive values stored as a Kubernetes Secret, encrypted with SOPS in the git repository:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: openclaw-secrets
  namespace: open-webui
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "sk-ant-..."
  OPENCLAW_GATEWAY_TOKEN: "a-long-random-token"
```

The `ANTHROPIC_API_KEY` authenticates with Anthropic's API for model access. The `OPENCLAW_GATEWAY_TOKEN` is a secondary authentication layer -- any client connecting to the gateway must provide this token. More on why this matters in the ingress section.

### ConfigMap

The gateway configuration file defines model providers, aliases, and behavior settings:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: openclaw-config
  namespace: open-webui
data:
  config.yaml: |
    gateway:
      port: 18789
      bind: lan
    providers:
      anthropic:
        api_key: ${ANTHROPIC_API_KEY}
        models:
          - name: sonnet
            model_id: claude-sonnet-4-5-20250301
            default: true
          - name: claude-opus-4-6
            model_id: claude-opus-4-6-20250601
          - name: claude-haiku-4-5
            model_id: claude-haiku-4-5-20250301
```

### The Init Container Pattern

Here is where it gets interesting. OpenClaw expects its config file to be writable -- it modifies configuration at runtime when you use the built-in Control UI. But Kubernetes ConfigMap mounts are read-only. Writing to a ConfigMap-mounted path fails with `EROFS`.

The solution is an init container that copies the ConfigMap to the PVC before the main container starts:

```yaml
initContainers:
  - name: copy-config
    image: busybox:1.36
    command: ['sh', '-c', 'cp /config-readonly/config.yaml /data/.openclaw/config.yaml']
    volumeMounts:
      - name: config-readonly
        mountPath: /config-readonly
      - name: openclaw-data
        mountPath: /data/.openclaw
```

On every pod restart, the init container overwrites the config on the PVC with the version from the ConfigMap. This means any changes made via the Control UI are lost on restart -- which is intentional. The ConfigMap in git is the source of truth. If I want a permanent config change, I update the ConfigMap and redeploy.

### Persistent Volume Claim

A 10Gi Longhorn PVC stores OpenClaw's persistent data -- session history, user preferences, and the runtime-writable config:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-data
  namespace: open-webui
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: longhorn
  resources:
    requests:
      storage: 10Gi
```

One important note: the PVC uses the standard `longhorn` StorageClass, not the encrypted variant (`longhorn-encrypted`). Encrypted Longhorn PVCs have persistent CSI staging path failures on this cluster -- a known issue where the CSI driver cannot find the staging path after a node reboot, leaving the volume stuck in `ContainerCreating`. Switching to unencrypted storage eliminated the problem entirely.

### Deployment

The full Deployment spec:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw
  namespace: open-webui
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: openclaw
  template:
    metadata:
      labels:
        app: openclaw
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      initContainers:
        - name: copy-config
          image: busybox:1.36
          command: ['sh', '-c', 'cp /config-readonly/config.yaml /data/.openclaw/config.yaml']
          volumeMounts:
            - name: config-readonly
              mountPath: /config-readonly
            - name: openclaw-data
              mountPath: /data/.openclaw
      containers:
        - name: openclaw
          image: 855878721457.dkr.ecr.us-east-1.amazonaws.com/k3s-homelab/openclaw:latest
          ports:
            - containerPort: 18789
          envFrom:
            - secretRef:
                name: openclaw-secrets
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: openclaw-data
              mountPath: /home/node/.openclaw
      volumes:
        - name: openclaw-data
          persistentVolumeClaim:
            claimName: openclaw-data
        - name: config-readonly
          configMap:
            name: openclaw-config
```

Key decisions:

- **`Recreate` strategy** -- not `RollingUpdate`. There is one replica accessing a `ReadWriteOnce` PVC. Rolling update would try to start a new pod while the old one still holds the volume, causing a mount conflict.
- **`nodeSelector: kubernetes.io/arch: amd64`** -- OpenClaw's native dependencies (compiled during `npm install`) are amd64 binaries. Scheduling on the arm64 Mac Mini node would fail with exec format errors.
- **Resources** -- 100m-2 CPU and 256Mi-2Gi memory. The gateway idles at ~80MB but spikes during WebSocket message processing and tool execution. The 2Gi limit provides headroom for the elevated tools (code execution) feature.
- **`runAsUser: 1000`** -- Matches the `USER 1000` in the Dockerfile. The PVC's `fsGroup: 1000` ensures the persistent data directory is writable.

### Service

A standard ClusterIP service exposes the gateway within the cluster:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: openclaw
  namespace: open-webui
spec:
  selector:
    app: openclaw
  ports:
    - port: 18789
      targetPort: 18789
```

### Why `--bind lan` Is Required

This is the most important deployment detail and the one that cost the most debugging time.

By default, OpenClaw binds to `loopback` -- `127.0.0.1`. This is fine for local development but fatal in Kubernetes. When the gateway listens only on loopback:

- The Kubernetes Service cannot route traffic to the pod (the Service connects to the pod's network interface, not loopback)
- Liveness and readiness probes fail (kubelet connects from outside the pod)
- Other pods in the cluster cannot reach the gateway

The fix is `--bind lan`, which tells OpenClaw to listen on `0.0.0.0`. But `--bind lan` has a side effect: it requires authentication. Without a gateway token or password, OpenClaw refuses to start with a `--bind lan` flag. This is a security measure -- binding to a network interface without authentication would expose the gateway to any traffic that reaches the pod.

The `OPENCLAW_GATEWAY_TOKEN` environment variable satisfies this requirement. Set the token, add `--bind lan`, and the gateway starts on all interfaces with token-based authentication.

## Connecting to Anthropic

The primary model provider is Anthropic's direct API, configured via the `ANTHROPIC_API_KEY` environment variable from the Kubernetes Secret.

### Model Configuration

Three models are available:

| Model | Alias | Use Case |
|-------|-------|----------|
| Claude Sonnet 4.5 | `sonnet` (default) | Everyday chat, general questions |
| Claude Opus 4.6 | -- | Complex reasoning, long documents |
| Claude Haiku 4.5 | -- | Quick queries, low-cost tasks |

Claude Sonnet 4.5 is set as the default because it hits the sweet spot of quality and cost for typical chat usage. Opus 4.6 is available for the occasional complex task, and Haiku 4.5 for high-volume, low-complexity queries.

### Why Direct API Instead of Bedrock

The [previous deployment](/posts/2026-03-04-private-ai-chat/) used AWS Bedrock exclusively, with LiteLLM as a translation proxy. For OpenClaw, I switched the primary path to Anthropic's direct API for three reasons:

1. **Lower latency.** Bedrock adds SigV4 authentication overhead on every request. The Anthropic API uses a simple bearer token. First-token latency is noticeably lower.
2. **Simpler auth.** An API key in an environment variable vs. IAM users, policies, access keys, and region-specific endpoints. Less infrastructure to manage.
3. **Newer models faster.** Anthropic's API typically gets new model releases and updates before they appear on Bedrock.

Bedrock remains available as a fallback through LiteLLM. The multi-provider setup is covered in the [follow-up post](/posts/2026-03-16-openclaw-multi-user/).

## Ingress and Authentication

### Reusing OAuth2 Proxy

The cluster already has an OAuth2 Proxy deployment in the `public-ingress` namespace that gates external access behind Google OAuth with an email whitelist. Adding OpenClaw was a single change to the IngressRoute -- swap the service name from `open-webui` to `openclaw` and update the port:

```yaml
- match: Host(`chat.k3s.strommen.systems`)
  middlewares:
    - name: oauth2-redirect-errors
      namespace: public-ingress
    - name: google-oauth
      namespace: public-ingress
  services:
    - name: openclaw
      namespace: open-webui
      port: 18789
```

Because I kept the `open-webui` namespace name when replacing the app, the IngressRoute stayed in the same namespace. The only changes were the service name and port number. No DNS updates, no certificate changes, no OAuth client reconfiguration.

### Gateway Token as Secondary Auth

OAuth2 Proxy handles who can access the gateway. The gateway token handles what can access the gateway. They are complementary:

- **OAuth2 Proxy** -- authenticates users via Google login, enforces the email whitelist, sets the `X-Forwarded-Email` header for user identification
- **Gateway token** -- authenticates API connections to the gateway process itself, prevents unauthorized in-cluster access

For external users (web browser), OAuth2 Proxy handles everything. The gateway token is injected automatically. For internal cluster consumers (if any service wanted to call OpenClaw programmatically), the gateway token would need to be provided explicitly.

## The Gotchas

Six issues discovered during deployment, in order of debugging time:

### 1. `gateway.bind` Only Accepts Keywords

The first instinct when binding to all interfaces is to set `gateway.bind: "0.0.0.0"`. This fails. OpenClaw's bind parameter only accepts keywords: `loopback`, `lan`, `tailnet`, `auto`, or `custom`. The correct value for Kubernetes is `lan`, which internally resolves to `0.0.0.0`. Setting a raw IP address causes a configuration validation error at startup.

### 2. `--bind lan` Requires Authentication

Binding to `lan` without setting either `OPENCLAW_GATEWAY_TOKEN` or a gateway password causes the process to exit with an error. This is intentional -- OpenClaw refuses to listen on a network interface without authentication. The error message is clear, but if you are iterating on the deployment and have not set up secrets yet, this blocks progress.

### 3. No Published Docker Image

Unlike most modern web applications, OpenClaw does not publish container images to Docker Hub or GHCR. The only distribution channel is npm. You must build your own Docker image, which means maintaining a Dockerfile and a CI pipeline for image builds. This is not hard, but it is unexpected.

### 4. Encrypted Longhorn PVCs Have CSI Staging Failures

Encrypted Longhorn PVCs (`storageClassName: longhorn-encrypted`) intermittently fail to mount after node reboots. The CSI driver reports that the staging path does not exist. The volume stays in `ContainerCreating` indefinitely. Switching to the standard `longhorn` StorageClass resolved the issue. This is a known Longhorn issue, not specific to OpenClaw.

### 5. Native Compilation Dependencies

The `npm install` step fails without `python3`, `make`, `g++`, and `libopus-dev`. These are build dependencies for `@discordjs/opus`, which uses node-gyp to compile a native C++ binding. The error output from node-gyp is verbose but not immediately helpful if you are not familiar with native Node.js modules. The fix is simple -- install the build tools in the Dockerfile before running `npm install`.

### 6. Config File Must Be Writable

OpenClaw modifies its configuration file at runtime whenever you change settings via the built-in Control UI. Kubernetes ConfigMap mounts are read-only. If the config file is on a ConfigMap mount, any attempt to save settings from the Control UI fails silently. The init container pattern -- copy config from ConfigMap to PVC on startup -- solves this while keeping the ConfigMap as the source of truth.

## Lessons Learned

1. **Lighter is better for homelab deployments.** An npm package that installs in seconds with a 5-line Dockerfile beats a Helm chart with dozens of values and a StatefulSet. The operational simplicity of a standard Deployment with `Recreate` strategy is hard to overstate when you are the only operator.

2. **WebSocket-based gateways need explicit network binding in containers.** Any service that defaults to loopback binding will be invisible to Kubernetes networking. This is not unique to OpenClaw -- it applies to any gateway, proxy, or server that defaults to `127.0.0.1`. Always check the bind address configuration when containerizing a new service.

3. **The init container config copy pattern solves read-only ConfigMap mounts.** When an application needs a writable config file, mount the ConfigMap to a temporary path and copy it to the PVC in an init container. The ConfigMap remains the source of truth in git, and the application gets a writable copy at runtime. This pattern is reusable across any application with the same constraint.

4. **Keep the namespace name when replacing an application.** Renaming from `open-webui` to `openclaw` would have required updating IngressRoutes, NetworkPolicies, ServiceMonitors, and every reference to the namespace across the cluster. Keeping the namespace name made the swap a single service-name change. The namespace name is an implementation detail, not a meaningful identifier.

The multi-user setup, privacy configuration, dual model providers (Anthropic + Bedrock), and per-user cost tracking are covered in the [follow-up post](/posts/2026-03-16-openclaw-multi-user/).
