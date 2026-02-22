---
title: "OpenClaw Multi-User: Privacy, Dual AI Backends, and Per-User Cost Tracking"
date: 2026-03-16T20:00:00-06:00
draft: false
author: "zolty"
description: "Adding multi-user support with privacy guarantees, dual model providers (Anthropic direct API and AWS Bedrock via LiteLLM), and per-user cost tracking to OpenClaw on k3s."
tags: ["openclaw", "ai", "privacy", "bedrock", "anthropic", "kubernetes", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "OpenClaw multi-user AI gateway"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Multi-user AI chat with privacy guarantees, dual model providers (Anthropic direct API + AWS Bedrock via LiteLLM), and per-user cost tracking via Prometheus and Grafana. The admin cannot read other users' conversations. Three family members authenticate via Google OAuth, each getting isolated chat sessions. Anthropic serves as the primary model provider with lower latency, and Bedrock via LiteLLM acts as a fallback. Per-user spend is tracked through LiteLLM's Prometheus metrics without any surveillance of conversation content. This is a follow-up to the [OpenClaw on k3s](/posts/2026-03-14-openclaw-on-k3s/) setup post.

## The Privacy Problem

When self-hosting AI chat for family members, there is an uncomfortable default in almost every tool: the admin sees everything. Conversation history, prompts, uploaded files -- all of it is visible to whoever runs the instance. Most self-hosted AI platforms treat admin access as equivalent to full visibility because the assumed use case is either single-user or corporate (where the admin is supposed to have oversight).

For a family deployment, that is a dealbreaker. My wife should not have to wonder whether I can read her conversations with a chatbot. The whole point of self-hosting is control and privacy -- and that has to extend to privacy from the admin, not just from external parties.

### What Needs to Be Locked Down

Three categories of data need isolation:

1. **Chat sessions** -- the actual conversation content between a user and the model
2. **Data export** -- the ability to bulk-export another user's conversations
3. **Shared spaces** -- community prompt libraries, shared conversations, or any feature that leaks content between users

### OpenClaw's Privacy Configuration

OpenClaw has explicit toggles for all of these. The relevant settings:

```yaml
# Privacy settings
admin_chat_access: false    # Admin CANNOT view other users' chat sessions
admin_export: false         # Admin CANNOT export other users' data
community_sharing: false    # No shared prompt gallery or public conversations
```

With these three settings disabled, each user's conversations are opaque to everyone else -- including the admin. I can see that users exist and that they are making requests (via metrics), but I cannot see what they are asking or what the model responds.

### Per-Sender Session Isolation

OpenClaw supports per-sender session scoping, where each authenticated user gets their own isolated session context. Sessions have a 120-minute idle timeout -- if a user stops chatting for two hours, the next message starts a fresh session. This prevents context bleed between sessions and keeps memory usage bounded.

The user identity comes from the OAuth2 Proxy `X-Forwarded-Email` header. OpenClaw maps this to an internal user, and all session state is scoped to that identity. No user can see another user's sessions, even if they share the same browser on a shared device.

## Authentication Architecture

The authentication chain has multiple layers, each serving a distinct purpose:

```text
Internet
  │
  ▼
CloudFront (CDN + TLS termination)
  │
  ▼
AWS WAF (rate limiting, geo-blocking, bot detection)
  │
  ▼
OAuth2 Proxy (Google OAuth, email whitelist)
  │
  ▼
OpenClaw (gateway token validation)
  │
  ▼
AI Model Providers (Anthropic API / Bedrock)
```

### Google OAuth with Email Whitelist

The same OAuth2 Proxy instance that protects the cluster dashboard, Home Assistant, and other public services handles authentication for OpenClaw. Three Google email addresses are whitelisted -- one for each family member. Anyone not on the list gets a 403 after the Google login screen.

This is the same pattern from the [original Open WebUI deployment](/posts/2026-03-04-private-ai-chat/), just extended to cover the OpenClaw endpoint. No additional OAuth client configuration was needed.

### Why the Gateway Token Matters

OAuth2 Proxy handles external access control, but OpenClaw also requires a `OPENCLAW_GATEWAY_TOKEN` for API-level authentication. This serves two purposes:

1. **Defense in depth** -- if someone bypasses OAuth2 Proxy (misconfigured ingress, direct pod access from within the cluster), they still cannot use the API without the token
2. **Internal access control** -- other services in the cluster can call OpenClaw directly via the ClusterIP service, but they need the gateway token. This prevents any pod from using the AI gateway without explicit authorization

The token is stored in a Kubernetes Secret and mounted as an environment variable. External users never see it -- OAuth2 Proxy injects the necessary headers automatically.

### User Identity Flow

The full identity chain works like this:

1. User authenticates with Google via OAuth2 Proxy
2. OAuth2 Proxy sets `X-Forwarded-Email` header with the user's Google email
3. OpenClaw reads the email header and maps it to an internal user identity
4. All API requests to model providers include the user identity in the `user` field
5. LiteLLM (for Bedrock requests) logs the user identity in Prometheus metrics

This means per-user cost tracking works end-to-end without any additional identity plumbing.

## Dual Model Providers

Running two model providers serves two purposes: redundancy and cost optimization. If the Anthropic API goes down, requests fail over to Bedrock. And different models have different cost profiles -- sometimes the cheaper option is good enough.

### Primary: Anthropic Direct API

The Anthropic API is the primary provider. Configuration is minimal -- a single API key stored in a Kubernetes Secret:

```yaml
# Anthropic provider configuration
provider: anthropic
api_key: ${ANTHROPIC_API_KEY}  # From K8s Secret

models:
  - name: sonnet              # Alias for quick selection
    model_id: claude-sonnet-4-5-20250301
    default: true
  - name: claude-opus-4-6
    model_id: claude-opus-4-6-20250601
  - name: claude-haiku-4-5
    model_id: claude-haiku-4-5-20250301
```

Claude Sonnet 4.5 is the default model -- best balance of quality and cost for everyday chat. Opus 4.6 is available for complex reasoning tasks, and Haiku 4.5 for quick, cheap queries.

**Why Anthropic direct over Bedrock as primary:**

- **Lower latency** -- direct API calls skip the SigV4 authentication overhead that Bedrock requires. First-token latency is noticeably lower.
- **Simpler configuration** -- an API key vs. IAM users, policies, and region-specific endpoints.
- **Newer models faster** -- Anthropic's own API typically gets new model releases before Bedrock does.

### Fallback: LiteLLM to AWS Bedrock

The LiteLLM proxy from the [Open WebUI deployment](/posts/2026-03-04-private-ai-chat/) is still running in the cluster. Rather than decommission it, I configured it as a fallback provider for OpenClaw:

```yaml
# LiteLLM as secondary provider
provider: litellm
base_url: http://litellm.open-webui.svc.cluster.local:4000/v1

models:
  - name: claude-sonnet-bedrock
  - name: claude-haiku-bedrock
  - name: nova-micro
  - name: nova-lite
  - name: nova-canvas
```

### Failover Behavior

OpenClaw's provider failover works at the request level. If a request to the Anthropic API fails (timeout, 500 error, rate limit), OpenClaw retries against the LiteLLM/Bedrock provider. The user sees a slightly longer response time but no error.

In practice, the Anthropic API has been reliable enough that failover rarely triggers. But having Bedrock as a backup means a regional Anthropic outage does not take down the family chat.

### Cost Comparison

Running both providers also provides a natural cost comparison. The same model accessed through different providers has different pricing:

| Model | Anthropic Direct (Input/1M) | Anthropic Direct (Output/1M) | Bedrock (Input/1M) | Bedrock (Output/1M) |
|---|---|---|---|---|
| Claude Sonnet 4.5 | $3.00 | $15.00 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $0.80 | $4.00 | $0.80 | $4.00 |
| Nova Micro | N/A | N/A | $0.035 | $0.14 |
| Nova Lite | N/A | N/A | $0.06 | $0.24 |

For Claude models, the per-token pricing is identical between Anthropic direct and Bedrock. The difference is operational: Bedrock has no separate API billing -- it rolls into the AWS bill alongside everything else. Anthropic direct requires a separate billing relationship.

The Nova models are Bedrock-exclusive and significantly cheaper than Claude. For simple tasks (summarization, formatting, quick factual questions), routing to Nova Micro at $0.035/1M input tokens is effectively free.

{{< ad >}}

## LiteLLM as a Model Proxy

LiteLLM was originally deployed for the [Open WebUI stack](/posts/2026-03-04-private-ai-chat/) as the translation layer between OpenAI-compatible APIs and AWS Bedrock. With the move to OpenClaw, LiteLLM's role shifted from primary proxy to fallback provider -- but the deployment is identical.

### Configuration for Bedrock Models

The LiteLLM ConfigMap now includes Nova Canvas in addition to the original four models:

```yaml
model_list:
  - model_name: claude-sonnet-bedrock
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0
      aws_region_name: us-east-1
  - model_name: claude-haiku-bedrock
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
  - model_name: nova-canvas
    litellm_params:
      model: bedrock/us.amazon.nova-canvas-v1:0
      aws_region_name: us-east-1

litellm_settings:
  drop_params: true
  telemetry: false
  success_callback: ["prometheus"]
```

The `drop_params: true` setting remains essential. OpenClaw sends parameters that Bedrock does not support, and without this flag, LiteLLM returns 400 errors instead of silently dropping the unsupported fields.

The key addition for cost tracking is `success_callback: ["prometheus"]`. This tells LiteLLM to emit Prometheus metrics on every successful request, including token counts, latency, and -- critically -- the `end_user` label that enables per-user cost attribution.

### ServiceMonitor

The existing ServiceMonitor in the `open-webui` namespace scrapes LiteLLM's `/metrics` endpoint every 30 seconds:

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

No changes were needed here. The same ServiceMonitor that was deployed for Open WebUI continues to work with OpenClaw's traffic flowing through LiteLLM.

## Per-User Cost Tracking

This is where the architecture pays off. OpenClaw passes the authenticated user's email in the `user` field of every API request to LiteLLM. LiteLLM maps this to the `end_user` label in its Prometheus metrics. The result: per-user cost attribution without reading anyone's conversations.

### How User Identity Flows to Metrics

```text
User (alice@gmail.com)
  │
  ▼
OAuth2 Proxy → X-Forwarded-Email: alice@gmail.com
  │
  ▼
OpenClaw → API request with { "user": "alice@gmail.com" }
  │
  ▼
LiteLLM → Prometheus metric with end_user="alice@gmail.com"
  │
  ▼
Grafana → Cost per user dashboard
```

### Key Prometheus Metrics

LiteLLM exposes several metrics that power the cost tracking dashboard:

| Metric | Labels | Purpose |
|---|---|---|
| `litellm_requests_metric` | `end_user`, `model`, `status` | Request count per user per model |
| `litellm_spend_metric` | `end_user`, `model` | Estimated cost per user per model |
| `litellm_llm_api_latency_metric_bucket` | `model`, `le` | Response latency distribution per model |

### Grafana Dashboard Panels

The Grafana dashboard has four main panels:

**1. Cost per user over time** -- a stacked area chart showing daily spend per user. This is the primary accountability view. Each user can see their own cost trajectory without seeing anyone else's conversation content.

```promql
sum by (end_user) (
  increase(litellm_spend_metric[1d])
)
```

**2. Model usage distribution** -- a pie chart showing which models each user gravitates toward. Useful for understanding whether the default model selection is right or if users are constantly switching to a different model.

```promql
sum by (end_user, model) (
  increase(litellm_requests_metric{status="success"}[7d])
)
```

**3. Latency percentiles per model** -- a heatmap showing p50, p90, and p99 response times per model. This validates the "Anthropic is faster than Bedrock" assumption with real data.

```promql
histogram_quantile(0.90,
  sum by (model, le) (
    rate(litellm_llm_api_latency_metric_bucket[1h])
  )
)
```

**4. Bedrock cost vs. retail comparison** -- a stat panel showing total Bedrock spend alongside what the same usage would cost at ChatGPT Plus / Claude Pro subscription rates. At family usage volumes, the per-token cost is a fraction of a fixed subscription.

### Accountability Without Surveillance

This is the key principle: I can see that Alice spent $0.43 on Claude Sonnet this week across 12 requests, but I cannot see what she asked. The metrics tell me cost, model, and volume -- not content. Privacy and cost accountability are not at odds.

If someone starts burning through tokens at an unexpected rate, the Grafana dashboard shows it immediately. The conversation can happen without reading anyone's chat history -- "Hey, looks like your usage spiked this week, everything okay?" is a lot less invasive than scrolling through their conversations.

## Cost Analysis

At family usage volumes -- a few conversations per day across three users -- the per-token model is dramatically cheaper than per-seat subscriptions.

### Monthly Cost Estimates

| Scenario | Claude Sonnet (primary) | Nova Micro (light tasks) | Monthly Total |
|---|---|---|---|
| Light usage (5 conversations/day across all users) | ~$0.30 | ~$0.01 | ~$0.31 |
| Moderate usage (15 conversations/day) | ~$0.90 | ~$0.03 | ~$0.93 |
| Heavy usage (30 conversations/day) | ~$1.80 | ~$0.06 | ~$1.86 |

Assumptions: average conversation is 3,000 tokens input + 1,500 tokens output.

### Comparison to Subscriptions

| Option | Monthly Cost (3 users) |
|---|---|
| ChatGPT Plus | $60.00 ($20/seat) |
| Claude Pro | $60.00 ($20/seat) |
| Self-hosted (moderate usage) | ~$1.00 |

The self-hosted option is roughly 60x cheaper for three users at moderate usage. Even at heavy usage, the per-token cost does not come close to the subscription price. The break-even point where subscriptions become cheaper would require each user to have hundreds of long conversations per day -- far beyond realistic personal use.

The tradeoff is clear: subscriptions give you access to the absolute latest models, web search integration, and zero operational overhead. Self-hosted gives you cost savings, privacy control, and model flexibility -- but you maintain the infrastructure.

## Lessons Learned

**1. Privacy requires explicit configuration.** Most self-hosted AI chat tools default to admin-sees-all. OpenClaw has the right toggles, but they are not the defaults. If you are deploying for anyone other than yourself, audit every privacy setting before inviting users. The assumption should be "admin sees nothing" and you opt in to visibility, not the other way around.

**2. Dual providers add resilience for minimal complexity.** Adding Anthropic direct as a primary provider alongside the existing LiteLLM/Bedrock setup took about 30 minutes. The failover logic is built into OpenClaw -- no custom code, no load balancer, no health checks to configure. If one provider errors, the request goes to the other.

**3. Per-user cost tracking is trivial with LiteLLM and Prometheus.** The entire pipeline -- user identity in API requests, Prometheus metrics with the `end_user` label, Grafana dashboard -- required zero custom code. LiteLLM's `success_callback: ["prometheus"]` setting does all the heavy lifting. The hardest part was writing the PromQL queries for the dashboard.

**4. Reusing LiteLLM from the previous deployment saved significant setup time.** The LiteLLM proxy was already running, already had IAM credentials configured, and already had a ServiceMonitor for Prometheus. Pointing OpenClaw at it as a fallback provider was a single configuration block. Infrastructure that is already deployed and working is the easiest infrastructure to integrate.

**5. Gateway tokens are worth the friction.** Adding a second authentication layer (gateway token on top of OAuth2) felt like overkill initially. But it prevents any pod in the cluster from freeloading on the AI gateway, and it provides a kill switch -- rotate the token and all access stops immediately, regardless of OAuth2 state.

**6. Session isolation is not the same as conversation privacy.** Isolated sessions (per-sender scoping, idle timeouts) prevent context bleed between users at the model level. But admin visibility into stored conversations is a separate concern. Both need to be addressed. OpenClaw handles both, but they are configured independently -- it is easy to get one right and miss the other.

**7. Cost transparency builds trust.** Sharing the Grafana cost dashboard with family members -- "here is what your usage costs, here is what mine costs" -- turned AI chat from a mysterious expense into a transparent utility. Nobody uses it differently because of the visibility, but everyone appreciates knowing the cost is negligible compared to subscriptions.

## What Is Next

- **AlertManager rules** for cost anomalies -- if any user's daily spend exceeds $5, fire an alert
- **Model routing rules** -- automatically route simple queries to Nova Micro and complex ones to Claude Sonnet based on input length or detected intent
- **Usage quotas** -- soft limits per user per day, with Slack notifications when approaching the threshold
- **Conversation export for users** -- let each user export their own conversations without admin involvement, since admin export is disabled
