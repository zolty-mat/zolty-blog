---
title: "Self-Hosted AI Chat: Open WebUI, LiteLLM, and AWS Bedrock on k3s"
date: 2026-03-04T20:00:00-06:00
draft: false
author: "zolty"
description: "Deploying a private ChatGPT alternative on a homelab k3s cluster using Open WebUI, LiteLLM proxy, and four AWS Bedrock models -- with OAuth2 for access control."
tags: ["ai", "open-webui", "litellm", "bedrock", "kubernetes", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "Self-hosted AI chat deployment"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

I deployed a private, self-hosted ChatGPT alternative on the homelab k3s cluster. Open WebUI provides a polished chat interface. LiteLLM acts as a proxy that translates the OpenAI API into AWS Bedrock's Converse API. Four models are available: Claude Sonnet 4, Claude Haiku 4.5, Amazon Nova Micro, and Amazon Nova Lite. Authentication is handled by the existing OAuth2 Proxy -- no additional SSO configuration needed. The whole stack runs in three pods consuming under 500MB of RAM, and the only ongoing cost is per-request Bedrock pricing. No API keys from OpenAI or Anthropic required.

## Why Self-Host AI Chat?

I already use Claude Opus 4.6 via the CLI for infrastructure work and GitHub Copilot in VS Code for inline completion. But sometimes I just want a chat interface -- quick questions, brainstorming, drafting documentation, or letting someone else in the household try out an AI model without handing them a CLI.

The options were:

1. **Pay for ChatGPT Plus / Claude Pro** -- $20/month per seat, data goes to third parties
2. **Run a local model** -- the cluster's ThinkCentre M920q machines have no GPU, so anything meaningful would be painfully slow
3. **Self-host a chat UI pointed at a cloud API** -- pay only for what you use, data stays between your infrastructure and the API provider, full control over the interface

Option 3 won. AWS Bedrock was already in use for the Trade Bot's AI analysis (Claude Sonnet 4.5), so the billing relationship and IAM patterns were established. The incremental cost of chat queries is negligible at personal usage volumes.

> **Don't have a homelab?** This same architecture works on any Kubernetes cluster. A [$200-credit DigitalOcean account](https://www.digitalocean.com/?refcode=b9012919f7ff&utm_campaign=Referral_Invite&utm_medium=Referral_Program&utm_source=badge) with a managed Kubernetes cluster (DOKS) could run this entire stack for a few dollars per month — just swap the Longhorn storage for DigitalOcean Volumes.

## Architecture

The stack has three components:

```text
┌─────────────────────────────┐
│     Open WebUI (port 8080)  │  ← Chat UI, conversation history, user prefs
│     StatefulSet, 5Gi PVC    │     Longhorn persistent storage
├─────────────────────────────┤
│     LiteLLM Proxy (port 4000)│  ← OpenAI API → Bedrock Converse translation
│     Deployment               │     ServiceMonitor for Prometheus
├─────────────────────────────┤
│     Redis (port 6379)        │  ← WebSocket session cache
│     Deployment               │
└─────────────────────────────┘
          │
          ▼
    AWS Bedrock (us-east-1)
    ├── Claude Sonnet 4
    ├── Claude Haiku 4.5
    ├── Amazon Nova Micro
    └── Amazon Nova Lite
```

Open WebUI thinks it is talking to an OpenAI-compatible API. LiteLLM intercepts every request and translates it into the appropriate Bedrock Converse API call using IAM credentials. The models show up in the UI dropdown as `claude-sonnet`, `claude-haiku`, `nova-micro`, and `nova-lite`.

### Why LiteLLM Instead of Direct Bedrock?

Open WebUI supports "OpenAI-compatible" backends natively, but Bedrock is not OpenAI-compatible. It uses a completely different API surface (`bedrock-runtime`, `Converse` action, SigV4 auth). LiteLLM bridges this gap. It also provides:

- **Prometheus metrics** on `/metrics` -- request counts, latency histograms, error rates per model
- **Model aliasing** -- users see `claude-sonnet` instead of `us.anthropic.claude-sonnet-4-20250514-v1:0`
- **Fallback routing** -- if one model errors, requests can fail over to another
- **Cost tracking** -- logs input/output token counts per request

## The LiteLLM Configuration

LiteLLM runs as a single Deployment with its config baked into a ConfigMap:

```yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0
      aws_region_name: us-east-1
  - model_name: claude-haiku
    litellm_params:
      model: bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
      aws_region_name: us-east-1
  - model_name: nova-micro
    litellm_params:
      model: bedrock/us.amazon.nova-micro-v1:0
      aws_region_name: us-east-1
  - model_name: nova-lite
    litellm_params:
      model: bedrock/us.amazon.nova-lite-v1:0
      aws_region_name: us-east-1

general_settings:
  master_key: null
  disable_spend_logs: true

litellm_settings:
  drop_params: true
  telemetry: false
```

The `drop_params: true` setting is important. Open WebUI sends OpenAI-specific parameters (like `frequency_penalty` or tool definitions) that Bedrock does not support. Without `drop_params`, LiteLLM would reject those requests with a 400 error.

AWS credentials come from a Kubernetes Secret mounted as environment variables -- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` -- on a dedicated IAM user with only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions.

{{< ad >}}

## Open WebUI Helm Deployment

Open WebUI publishes an official Helm chart. The key values:

```yaml
# Disable built-in auth -- OAuth2 Proxy handles it
extraEnvVars:
  - name: WEBUI_AUTH
    value: "false"
  - name: ENABLE_OAUTH_SIGNUP
    value: "false"

# Point at the LiteLLM sidecar
ollamaUrls: []
openaiBaseApiUrl: "http://litellm.open-webui.svc.cluster.local:4000/v1"

# Longhorn storage for conversations and uploads
persistence:
  enabled: true
  size: 5Gi
  storageClass: longhorn

# Redis for WebSocket sessions
redis:
  enabled: true
```

One Helm gotcha: the chart creates a StatefulSet, not a Deployment. StatefulSets do not support `strategy.type: Recreate`. You have to use `OnDelete`, which means pods are only recreated when you manually delete them (or during `helm upgrade`). This tripped up the initial deployment.

## Authentication: Reusing OAuth2 Proxy

The cluster already has a battle-tested OAuth2 Proxy deployment in the `public-ingress` namespace. It gates external access to the cluster dashboard, Home Assistant, and other services behind Google OAuth with an email whitelist.

Adding Open WebUI was a single IngressRoute addition:

```yaml
- match: Host(`chat.k3s.strommen.systems`)
  middlewares:
    - name: google-oauth
      namespace: public-ingress
  services:
    - name: open-webui
      namespace: open-webui
      port: 80
```

No additional SSO configuration in Open WebUI itself. Setting `WEBUI_AUTH=false` disables the built-in login page entirely. Anyone who gets past OAuth2 Proxy is trusted. This is a deliberate choice -- a single-user homelab does not need two authentication layers.

## AWS IAM: Least Privilege for Bedrock

A dedicated IAM user (`open-webui-bedrock`) was created via Terraform with a minimal policy:

```hcl
module "open_webui_bedrock_iam" {
  source = "../../modules/open_webui_bedrock_iam"
}
```

The IAM policy grants:

- `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` -- the two actions needed for chat
- `bedrock:ListFoundationModels` and `bedrock:GetFoundationModel` -- so LiteLLM can verify model availability at startup
- `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe` -- required for accessing third-party models (Anthropic Claude) through Bedrock's marketplace

The user has no console access, no other AWS permissions, and the access key is stored in a Kubernetes Secret that only pods in the `open-webui` namespace can mount.

## Lessons Learned

### 1. LiteLLM Image Tags Are Not Semver

The LiteLLM container registry (`ghcr.io/berriai/litellm`) uses tags like `main-v1.81.12-stable`. The initial deployment tried `main-v1.63.14` (no `-stable` suffix) which did not exist. There is no `latest` tag that works reliably. Always check the actual tags on the GitHub Container Registry before deploying.

### 2. Bedrock Model Access Is Not Automatic

Even with the correct IAM permissions, Bedrock models require explicit "model access" grants in the AWS Console (or via API). Claude models are third-party and need marketplace subscription acceptance. The error message when access is missing is unhelpful -- a generic `AccessDeniedException` with no indication that it is a marketplace issue rather than an IAM issue.

### 3. Claude 3.5 Haiku Does Not Exist on Bedrock

During deployment, the initial configuration used `anthropic.claude-3-5-haiku-20241022-v1:0` as the Haiku model. This returned `AccessDeniedException` even after granting model access. The reason: Claude 3.5 Haiku was never made available on Bedrock. The correct model is Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`). Anthropic's naming conventions make this non-obvious.

### 4. Cross-Region Inference Prefixes Matter

Bedrock model IDs that start with `us.` (like `us.anthropic.claude-sonnet-4-20250514-v1:0`) use cross-region inference profiles. These route requests to the nearest available region and are generally more reliable than pinning to a single region. The non-prefixed IDs (`anthropic.claude-sonnet-4-20250514-v1:0`) only work in the specific region where the model is deployed.

### 5. StatefulSets Reject Recreate Strategy

Helm charts that create StatefulSets cannot use `strategy.type: Recreate`. The valid options are `RollingUpdate` and `OnDelete`. This is a Kubernetes API constraint, not a Helm issue. The error message is clear, but if you are used to Deployments, it is easy to forget.

### 6. Skip Built-In SSO When You Have an Ingress Auth Layer

Open WebUI supports Google OAuth natively, but configuring it requires setting up a separate OAuth client ID, managing redirect URIs, and handling the interaction between two authentication systems. When you already have OAuth2 Proxy at the ingress layer, it is simpler and more secure to disable Open WebUI's auth entirely (`WEBUI_AUTH=false`) and let the proxy handle access control.

## Observability

LiteLLM exposes Prometheus metrics on port 4000 at `/metrics`. A ServiceMonitor in the `open-webui` namespace scrapes these automatically:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: litellm
  namespace: open-webui
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: litellm
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

Key metrics to watch:

| Metric | What It Tells You |
|---|---|
| `litellm_requests_metric` | Total requests by model and HTTP status |
| `litellm_llm_api_latency_metric_bucket` | Response time distribution per model |
| `litellm_llm_api_failed_requests_metric` | Error count -- spikes here mean Bedrock issues |
| `litellm_deployment_latency_per_output_token` | Cost-efficiency indicator |

A Grafana dashboard for these metrics is on the TODO list. For now, the raw Prometheus queries work fine for a single-user deployment.

## Cost

At personal usage volumes, the cost is effectively zero beyond what the cluster already costs to run. Bedrock pricing:

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| Claude Sonnet 4 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $0.80 | $4.00 |
| Nova Micro | $0.035 | $0.14 |
| Nova Lite | $0.06 | $0.24 |

A typical chat conversation uses maybe 2,000-5,000 tokens. At Nova Micro pricing, that is $0.0001-$0.0003 per conversation. Even heavy daily use with Claude Sonnet would struggle to break $1/month.

## Final State

Three pods, under 500MB total RAM, a 5Gi PVC for conversation history, and four AI models accessible through a clean chat interface at `chat.k3s.strommen.systems`:

```
NAMESPACE    NAME                        READY   STATUS
open-webui   litellm-6b9f4c8d7-xxxxx     1/1     Running
open-webui   open-webui-0                1/1     Running
open-webui   open-webui-redis-xxxxx      1/1     Running
```

The deployment took about two hours including debugging model access issues. The LiteLLM proxy pattern is reusable -- any future Bedrock model can be added with a three-line config change and a `kubectl rollout restart`.

## What Is Next

- **Grafana dashboard** for LiteLLM metrics (request volume, latency percentiles, model distribution)
- **Custom system prompts** per model, preloaded with cluster knowledge from the Memory Protocol docs
- **RAG integration** -- pointing Open WebUI's document upload feature at the cluster documentation so it can answer questions about the infrastructure
- **Usage alerts** -- AlertManager rule if Bedrock spend exceeds a threshold

