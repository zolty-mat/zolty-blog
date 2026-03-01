---
title: "Getting Started with GitHub Copilot: What Actually Works"
date: 2026-03-01T06:00:00-06:00
draft: false
author: "zolty"
description: "A $20/month Copilot sub is the best AI tooling investment right now. Here's how to set it up so it actually knows your projects -- instructions, skills, memory, and model selection."
tags: ["ai", "copilot", "claude", "devops", "automation", "homelab", "productivity"]
categories: ["Operations"]
cover:
  image: "/images/covers/operations.svg"
  alt: "GitHub Copilot setup guide with AI skills and memory"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

A [$20/month GitHub Copilot subscription](https://github.com/features/copilot) gives you Claude Sonnet 4.6, GPT-4o, and Gemini inside VS Code. Out of the box it's useful. With a proper instruction setup — a `copilot-instructions.md` file, path-scoped rules, and skill documents — it becomes something you actually rely on. Most of the posts on this blog were built with this toolchain, mostly in the context of my k3s cluster, but the patterns apply anywhere. This is how I have it set up.

## Start Here If You're New to This

The best advice I can give someone picking up AI coding tools for the first time: **start with something you already know how to do.** Ask it to write a bash script you would have written yourself. Ask it to explain a piece of code you understand. Ask it to build a Jupyter notebook for something you already know the answer to.

The reason this matters is that you need a calibrated sense of what good output looks like before you start trusting the tool on things you don't know. AI tools are approachable — if you don't understand what it did, just ask it to explain. But you have to build the instinct for when it's confidently wrong, and you only get that by working in territory where you can verify the answer.

In my professional life I'm using Copilot for things that have nothing to do with homelabs. It's writing code, it's building Jupyter notebooks that report on cloud and operating budgets, it's reviewing tickets from my eight direct reports and flagging anything that's missing fields or doesn't have enough detail to act on. It's tracking level-of-effort across the team. The common thread is that I already understood these problems well enough to know when the AI got them right.

The best example of where this has paid off: we just migrated to Azure, and one of the first fights is always patching. HA is simply not possible for several of our services — databases being the obvious one — so dev is understandably protective about letting us patch. In AWS they wouldn't let us do it at all. The risk was too high and the documentation wasn't there to make them comfortable.

So I had Copilot write the whole patching process in Python. It keeps tickets updated, reviews patch severity, tests specific patches, and — the part that actually convinced dev — it writes tasks that actively exploit the CVE the patch is supposed to fix, proves we're vulnerable, applies the patch, then runs the same exploit again to prove we're not. It keeps Confluence, Slack, and our alert monitoring updated throughout. Dev now has the documentation, the testing, and the proof chain to feel confident letting us do something as basic as patching. We're running the POC this month and rolling it out next patch cycle.

That whole process was built with Copilot. I knew what a good patch workflow looked like. I knew what "done" meant. The AI wrote it, I reviewed it, and we're taking it to prod. That's the pattern that works.

## Which Model Should You Use

The Copilot subscription gives you access to Claude models at different tiers. Haiku, Sonnet, and Opus are **distinct models with genuinely different capabilities** — not the same thing at different settings.

| Model | What It's Good At |
|---|---|
| Haiku | Fast completions, simple bounded tasks, high-volume stuff |
| Sonnet | Most coding work, debugging, refactoring — the daily driver |
| Opus | Architecture decisions, complex multi-file analysis, when getting it right matters more than speed |

### Context Matters More Than Model Size

Here's the thing that isn't obvious at first: all three models have large context windows (200K tokens), but what you put in that context is more important than which model you pick. A Haiku call with a tight, relevant 2,000-token prompt will beat an Opus call drowning in 50,000 tokens of files the model has to wade through to find what's relevant.

Every time you open Copilot chat, it pulls in your open tabs, your terminal output, your instruction files. If you have 12 unrelated files open and a 500-line terminal buffer, you're spending that context budget on noise. The model can't tell what matters — that's on you.

In practice: use Sonnet for most things, Haiku when you just need something fast and simple, and Opus when you're working through something genuinely complex where you'd rather wait a bit longer and have it actually get there.

## Layer 1: copilot-instructions.md

This is the foundation. Copilot reads `.github/copilot-instructions.md` for every request in your workspace. Without it, every conversation starts from scratch — the AI has no idea what your project is, what patterns you follow, or what mistakes to avoid.

Think of it as the briefing document for a new engineer joining your team. What would they need to read to not immediately break something?

```markdown
# My Project — Copilot Operating System

## Memory Protocol

Before infrastructure changes: read `docs/ai-lessons.md` for failure patterns.
After significant work: update docs/ if new knowledge was discovered.

## Platform Identity

Private cloud running Proxmox VE + k3s Kubernetes. 7 nodes: 3 control plane,
4 workers (amd64 Debian 13). All infrastructure Terraform + Ansible managed.

## Engineering Principles

- Infrastructure as Code first: Terraform for provisioning, Ansible for config
- Declarative over imperative: manifests over shell scripts
- Least privilege: RBAC per-namespace, secrets in K8s secrets only
- Observable by default: every service exposes /metrics

## Architecture

- Traefik sole ingress controller. Do not install NGINX Ingress.
- MetalLB L2 LoadBalancer
- Longhorn distributed storage
- cert-manager TLS via Let's Encrypt DNS-01

## High-Impact Anti-Patterns

- Service selector trap: selector MUST include component label when postgres
  shares a namespace. Without it, ~50% of requests route to postgres (502s).
- ARC label replacement: 'labels' REPLACES defaults. 'self-hosted' MUST be listed.
- ECR tokens last 12h. Every deploy must refresh the pull secret.

## Decision Heuristics

- Adding a service: Read docs/new-service-checklist.md and follow exactly.
- Debugging 502s: Check Service selector includes component label first.
```

### What Not to Put Here

The most common mistake is dumping everything into this one file. It becomes a wall of text and the AI loses the signal. Keep this file as a navigation layer — telling the AI where to find things, not containing everything itself.

Move failure patterns and incident history to `docs/ai-lessons.md`. Move file-type conventions to path-scoped instruction files. Move domain procedures to skill files (more on those below).

### The Memory Protocol

The single most important thing to set up is a feedback loop. At the top of my instructions file:

```markdown
## Memory Protocol

Before infrastructure changes: read docs/ai-lessons.md for failure patterns
and docs/platform-reference.md for current state.

After significant work: update the relevant docs/ file if new knowledge was
discovered. Never store secrets or credentials.
```

Every time the AI makes a mistake that I catch, I add it to `docs/ai-lessons.md`. Next session, the AI reads it before touching anything. The mistake doesn't happen again. After a few months of this, the AI is meaningfully better at working in my specific environment than it was on day one — not because the model changed, but because it has accumulated knowledge about my setup.

## Layer 2: Path-Scoped Instructions

Copilot supports instruction files that only activate for specific file patterns, living in `.github/instructions/` with an `applyTo` header:

```
.github/instructions/
├── kubernetes.instructions.md   # applies to kubernetes/**/*.yml
├── terraform.instructions.md   # applies to **/*.tf
├── ansible.instructions.md     # applies to ansible/**/*.yml
├── ci-cd.instructions.md       # applies to .github/workflows/*.yml
└── docs.instructions.md        # applies to docs/**/*.md
```

Example:

```markdown
---
applyTo: "kubernetes/**/*.{yml,yaml}"
---

# Kubernetes Manifests

Every Deployment must include both labels:
```yaml
labels:
  app.kubernetes.io/name: myapp
  app.kubernetes.io/component: web
```

Omitting `component` causes Service selector issues when PostgreSQL
shares the namespace. All Ingresses use cert-manager letsencrypt-prod.
```

The point is specificity. When you're editing Terraform, you don't need the Ansible conventions. When you're in a GitHub Actions workflow, you don't need the Kubernetes manifest rules. The AI gets the right context for the right task without burning the context budget on things that don't matter.

**kubernetes.instructions.md**: Label requirements, ingress annotations, resource limits, image pull secrets.

**terraform.instructions.md**: Provider versions, naming conventions, module patterns, state backend config.

**ansible.instructions.md**: Idempotency patterns, variable precedence, role structure.

**ci-cd.instructions.md**: Runner labels, secret names, deployment strategies, auth refresh steps.

## Layer 3: Skill Files

Skills are the most useful and least talked-about part of the Copilot agent setup. A skill is a markdown file the agent reads when it figures out a task falls within that domain. You write it once, and instead of re-explaining your deployment procedure every session, the agent just loads it.

```
.claude/skills/
├── k3s-deployment/SKILL.md        # Full deployment checklist
├── k3s-debugging/SKILL.md         # Debugging procedures and triage
├── docker-ecr/SKILL.md            # Build and push to ECR
├── grafana-dashboards/SKILL.md    # Dashboard creation patterns
└── terraform-infra/SKILL.md       # Infrastructure provisioning
```

A skill file:

```markdown
---
name: k3s-deployment
description: Deploy new services to the k3s cluster. Use when adding a new application, service, or workload. Covers ECR setup, Kubernetes manifests, ServiceMonitor, CI/CD RBAC, and docs updates.
keywords: deploy, service, application, kubernetes, manifest, ecr, ingress
---

# K3s Deployment

## Deployment Checklist

1. Create ECR repository in Terraform
2. Write Namespace, Deployment, Service, Ingress manifests
3. Add ServiceMonitor for Prometheus scraping
4. Create GitHub Actions workflow
5. Configure runner RBAC (Role + RoleBinding)
6. Update docs/deployed-applications.md

## Common Mistakes

- Forgetting the component label on the Service selector
- ECR pull secret not refreshed in workflow
- Missing /metrics endpoint (every service must expose metrics)
```

Be prescriptive, not descriptive. "Create the ECR repository first" is useful. "ECR repositories are managed in Terraform" is not. Include real templates the agent can copy. End every skill file with the failure modes specific to that task in your environment — that's where the institutional knowledge actually lives.

## Layer 4: The Living Lessons Database

`docs/ai-lessons.md` is the file you build one incident at a time. Every time the AI recreates a fixed bug, every time a deployment fails in a predictable way, every time you catch it ignoring something it should know — you write it down:

```markdown
## Service Selector Missing Component Label

**Symptom**: ~50% of HTTP requests return 502. kubectl logs on the app pod
shows no requests arriving. Traefik upstream health checks are passing.

**Root Cause**: PostgreSQL shares the namespace. Service with only `app` label
matches both the app pod and the postgres pod. Traefik load-balances across both.

**Fix**: Add `app.kubernetes.io/component: web` to all Deployment pod labels
and the Service selector.

**Prevention**: Instruction file now requires both labels on every Deployment.
```

After 20-30 incidents this becomes a high-signal document that prevents entire categories of recurring mistakes. The AI reads it before touching infrastructure (that's the Memory Protocol directive). Mine is 482 lines now and that number directly correlates to how rarely those mistakes happen.

## Context Management in Practice

Nobody tells you this when you start: **context management is a skill you have to develop.** The AI doesn't know what's important. It weights everything in the context window roughly equally, so if you have 10,000 tokens of files the AI has to wade through to find 500 tokens of what actually matters, you're going to get mediocre answers regardless of which model you're running.

Every time you open Copilot chat, VS Code sends your open tabs, terminal output, instruction files, and anything you `#`-reference. If you have 15 tabs open, 14 unrelated, you're burning that context budget on noise.

A few things that actually help:

**Close files you're not touching.** Obvious but easy to forget.

**Use `#file` deliberately.** Reference only the file that's actually relevant, not the whole directory.

**Start a new chat when a session goes sideways.** If you've been debugging something for 45 minutes in one chat and there's a bunch of failed attempts in the history, those wrong turns are in the context too and they're hurting you. A fresh chat with a clean problem statement usually gets further faster.

**Ask specific questions.** "Debug my cluster" is a waste. "The readiness probe is failing after redeploy, here are the events: `[events]`. What's the most likely cause?" gives the model something to work with.

The counterintuitive part: for most tasks you're better off with Sonnet and good context than Opus with garbage in. The quality of what you feed it matters more than how powerful the model is.

## If You're Just Getting Started

Write the `copilot-instructions.md` first. Three sections is enough to start: what is this project, what are the 5-10 conventions that matter, and what are the 3-5 mistakes you want it to avoid. Keep it under 100 lines — you can always add more but you can't easily fix a bloated instructions file that the AI reads but doesn't prioritize.

Pick two file types you work with most and write path-scoped instruction files for them. Don't do ten on day one. You don't know yet what needs scoped instructions.

Take your most complex recurring task — the one where you always have to look up the steps or copy from a previous implementation — and write it as a skill file. Next time you need to do it, have Copilot load the skill.

After your first significant mistake, start `docs/ai-lessons.md` with one entry. Add to it every time something goes wrong.

Run that for a week and then adjust based on where it helped and where it didn't. Those gaps will tell you exactly what to add.

## What I Got Wrong First

I set up Copilot with no instructions and spent a while being annoyed that it kept suggesting NGINX Ingress when Traefik is the sole ingress controller in my cluster. It kept generating arm64 Docker builds for an amd64-only environment. It kept creating PostgreSQL configs without any awareness of Longhorn's storage constraints.

Every one of those was my fault. The model had no way to know. Once I added those constraints to the instruction system, they stopped. The biggest shift in how I think about this tooling: **every AI mistake is a documentation failure, not a model failure.** If the AI did something wrong that it could have done right with the right context, add that context. It takes 10 minutes. The mistake doesn't happen again.

---

*Check out [AI-Assisted Infrastructure: Claude, Copilot, and the Memory Protocol](/posts/2026-02-22-ai-assisted-infrastructure/) for how this whole toolchain comes together for infrastructure work, and [Building an AI Memory System](/posts/2026-02-26-ai-memory-system/) for how the instruction architecture evolved over time.*