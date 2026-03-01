---
title: "GitHub Copilot from Zero: Skills, Memory, and Model Strategy for Real Projects"
date: 2026-03-01T20:00:00-06:00
draft: false
author: "zolty"
description: "A practical guide to setting up GitHub Copilot right -- instructions, skills, path-scoped prompts, model selection, and why context management matters more than raw model size."
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

A $20/month GitHub Copilot subscription is currently the best-value AI coding tool available, giving you access to Claude Sonnet 4.6 inside VS Code. But the default setup gets you maybe 30% of the potential. The remaining 70% comes from a proper instruction architecture: a project-level `copilot-instructions.md` that acts as the AI's operating system, path-scoped instruction files for specific file types, and domain skill files the AI reads on demand. This post covers the full architecture I use across five repositories, including the mistakes that made me build it.

## Why Copilot in 2026

There are three serious AI coding tools right now: GitHub Copilot, Cursor, and direct Claude/GPT API access. I use all three but Copilot is the one that stays open all day. The reasons:

- **Native VS Code integration** — it reads your open tabs, your terminal output, your error panel. It has workspace context without you having to paste anything.
- **Multi-model access** — the $20/month plan includes Claude Sonnet 4.6, GPT-4o, and Gemini 2.0 Flash. You pick the right model for the task.
- **Instruction system** — the `copilot-instructions.md` + `instructions/` directory architecture is genuinely powerful once you understand it.
- **Skills (agent tools)** — custom document files the AI loads on demand for domain-specific tasks. This is underused and underappreciated.

What you get out of the box is autocomplete and a chat panel. What you build over time is a persistent AI collaborator that remembers your architecture, avoids your known failure modes, and speaks your project's language.

## Model Selection: Haiku, Sonnet, Opus

The Copilot subscription gives you access to Claude models at different tiers. Understanding the tradeoffs is important because: **the wrong model choice makes AI tools worse, not just slower**.

### The Three Tiers

| Model | Capability | Speed | Best For |
|---|---|---|---|
| Haiku | Fast reasoning, smaller | Fastest | Line completions, quick answers, high-volume tasks |
| Sonnet | Balanced capability | Medium | Most coding tasks, multi-step refactoring, debugging |
| Opus | Deepest reasoning | Slowest | Complex architecture decisions, multi-file analysis |

These are **distinct models with different training**, not the same model at different compression ratios. Opus is meaningfully smarter on complex reasoning tasks. Haiku is meaningfully faster for simple ones.

### Context Is the Real Variable

Here is the thing that actually bites people: **all three models have large context windows (200K tokens), but how you fill that context determines everything**.

A Haiku inference with a tight, relevant 2,000-token context will outperform an Opus inference drowning in 50,000 tokens of irrelevant file contents. The model cannot distinguish signal from noise in your context — that is your job.

Every time you open a new Copilot chat:
- Files you have open in VS Code get included
- Your terminal output may get included
- Your instruction files get included
- Any files you `#`-reference get included

An unfocused session with 12 tabs open, a 500-line terminal buffer, and a 200-line instructions file is burning tokens on content the model will weight equally with what actually matters.

### Practical Model Selection

- **Haiku**: Use in the inline autocomplete flow where latency matters. Use when the task is obviously bounded (write a bash one-liner, complete this YAML field, generate a SQL query).
- **Sonnet**: Use for most chat interactions. Debugging session, "explain this error", "refactor this function", "write the Kubernetes manifest for this service". This is the daily driver.
- **Opus**: Use when you are making architectural decisions, analyzing a complex failure across multiple systems, or doing something where getting it right matters more than getting it fast. Once a week, not hourly.

## Layer 1: copilot-instructions.md

The foundation of the whole system. GitHub Copilot reads this file for every request in your workspace. It is the AI's persistent memory between sessions — without it, every conversation starts from zero.

Create `.github/copilot-instructions.md` in your repository root.

### What Belongs Here

Think of it as the AI's **project briefing document**. A new senior engineer joining your team would need to read it to understand:

```markdown
# My Project — Copilot Operating System

## Memory Protocol

Before infrastructure changes: read `docs/ai-lessons.md` for failure patterns.
After significant work: update docs/ if new knowledge was discovered.

## Platform Identity

<!-- What is this system? -->
Private cloud running Proxmox VE + k3s Kubernetes. 7 nodes: 3 control plane,
4 workers (amd64 Debian 13). All infrastructure Terraform + Ansible managed.

## Engineering Principles

<!-- How are decisions made here? -->
- Infrastructure as Code first: Terraform for provisioning, Ansible for config
- Declarative over imperative: manifests over shell scripts
- Least privilege: RBAC per-namespace, secrets in K8s secrets only
- Observable by default: every service exposes /metrics

## Architecture

<!-- What does the system look like? -->
- Traefik sole ingress controller. Do not install NGINX Ingress.
- MetalLB L2 LoadBalancer
- Longhorn distributed storage
- cert-manager TLS via Let's Encrypt DNS-01

## High-Impact Anti-Patterns

<!-- What mistakes does the AI keep making? -->
- Service selector trap: selector MUST include component label when postgres
  shares a namespace. Without it, ~50% of requests route to postgres (502s).
- ARC label replacement: 'labels' REPLACES defaults. 'self-hosted' MUST be listed.
- ECR tokens last 12h. Every deploy must refresh the pull secret.

## Decision Heuristics

<!-- Quick reference for common situations -->
- Adding a service: Read docs/new-service-checklist.md and follow exactly.
- Debugging 502s: Check Service selector includes component label first.
```

### What Does NOT Belong Here

The most common mistake is stuffing `copilot-instructions.md` with everything. It becomes a 500-line wall of text that the AI reads but fails to prioritize.

**Do not put in copilot-instructions.md:**
- Failure patterns and incident history → move to `docs/ai-lessons.md`
- File-type-specific conventions → move to path-scoped instructions
- Domain procedure documentation → move to skill files
- Specific configuration values → link to the file instead of duplicating

The copilot-instructions file should be a **navigation layer** that tells the AI where to find things, not the thing itself.

### The Memory Protocol Pattern

The most important feature of the instructions file is establishing a memory protocol. At the top of my instructions file is this directive:

```markdown
## Memory Protocol

Before infrastructure changes: read docs/ai-lessons.md for failure patterns
and docs/platform-reference.md for current state.

After significant work: update the relevant docs/ file if new knowledge was
discovered. Never store secrets or credentials.
```

This creates a feedback loop. Every time you discover a new failure pattern, you add it to `docs/ai-lessons.md`. The AI reads it next session. The mistake does not get repeated. Over time, the AI gets better at working in your specific environment.

## Layer 2: Path-Scoped Instructions

GitHub Copilot supports instruction files that only activate for specific file patterns. These live in `.github/instructions/` and use an `applyTo` front matter field.

```
.github/instructions/
├── kubernetes.instructions.md   # applies to kubernetes/**/*.yml
├── terraform.instructions.md   # applies to **/*.tf
├── ansible.instructions.md     # applies to ansible/**/*.yml
├── ci-cd.instructions.md       # applies to .github/workflows/*.yml
└── docs.instructions.md        # applies to docs/**/*.md
```

Example structure for a file:

```markdown
---
applyTo: "kubernetes/**/*.{yml,yaml}"
---

# Kubernetes Manifests

## Required Labels

Every Deployment must include both labels:
```yaml
labels:
  app.kubernetes.io/name: myapp
  app.kubernetes.io/component: web
```

Omitting `component` causes Service selector issues when PostgreSQL
shares the namespace.

## Ingress

All Ingresses use cert-manager:
```yaml
annotations:
  cert-manager.io/cluster-issuer: letsencrypt-prod
```

Never use self-signed certs in production manifests.
```

The benefit here is **specificity without noise**. When you are editing a Terraform file, you do not need the Ansible conventions. When you are writing a GitHub Actions workflow, you do not need the Kubernetes manifest rules. The AI gets the right context for the right task without context budget waste.

### What to Put in Each File

**kubernetes.instructions.md**: Label requirements, ingress annotations, resource limits, SecurityContext defaults, StorageClass choices, image pull secrets.

**terraform.instructions.md**: Provider versions, naming conventions, module patterns, state backend config, which resources to import vs recreate.

**ansible.instructions.md**: Idempotency patterns, variable precedence, role structure, when to use handlers vs direct tasks.

**ci-cd.instructions.md**: Runner labels, secret names, environment names, deployment strategy (Recreate vs RollingUpdate), ECR auth refresh steps.

## Layer 3: Skill Files

Skills are the most powerful and least understood feature of the Copilot agent system. A skill is a markdown file that the AI agent reads on demand when it detects the task falls within that domain.

```
.claude/skills/
├── k3s-deployment/
│   └── SKILL.md        # Full deployment checklist
├── k3s-debugging/
│   └── SKILL.md        # Debugging procedures and triage steps
├── docker-ecr/
│   └── SKILL.md        # Build and push to ECR
├── grafana-dashboards/
│   └── SKILL.md        # Dashboard creation patterns
└── terraform-infra/
│   └── SKILL.md        # Infrastructure provisioning procedures
```

The skill file is a detailed, domain-specific document that you would otherwise have to paste into every conversation. Instead, you write it once and the agent loads it when relevant.

A minimal skill file looks like this:

```markdown
---
name: k3s-deployment
description: Deploy new services to the k3s cluster. Use when adding a new application, service, or workload. Covers ECR setup, Kubernetes manifests, ServiceMonitor, CI/CD RBAC, and docs updates.
keywords: deploy, service, application, kubernetes, manifest, ecr, ingress
---

# K3s Deployment

## When to Use This Skill

- Adding a new application to the cluster
- Creating Kubernetes manifests for an existing service
- Setting up CI/CD for a new app

## Deployment Checklist

1. Create ECR repository in Terraform
2. Write Namespace, Deployment, Service, Ingress manifests
3. Add ServiceMonitor for Prometheus scraping
4. Create GitHub Actions workflow
5. Configure runner RBAC (Role + RoleBinding)
6. Update docs/deployed-applications.md

## Manifest Templates

[... actual YAML templates ...]

## Common Mistakes

- Forgetting the component label on the Service selector
- ECR pull secret not refreshed in workflow
- Missing /metrics endpoint (every service must expose metrics)
```

### Skill File Best Practices

**Be prescriptive, not descriptive.** The skill file is not documentation about how the system works. It is instructions for what to do. "Create the ECR repository first" is better than "ECR repositories are managed in Terraform."

**Include actual templates and code.** The agent will use them. Generic descriptions of what YAML "should look like" are useless. Actual YAML the agent can copy and modify is valuable.

**List the failure modes.** Every skill file should end with "Common Mistakes" or "Anti-Patterns" — the things that go wrong on this type of task in your specific environment. This is where institutional knowledge lives.

**Keep descriptions tight for the agent's skill-selection logic.** The `description` field in the front matter is what the agent uses to decide whether to load the skill. It needs to be specific enough that the agent loads it when relevant and does not load it when not.

## Layer 4: The Living Lessons Database

`docs/ai-lessons.md` is the most important file in the system that you do not write upfront. You build it incrementally, one incident at a time.

Every time:
- The AI recreates a bug that has been fixed before
- A deployment fails in a predictable way
- You catch the AI ignoring a constraint it should know about

...you add a new entry. The format is consistent:

```markdown
## Service Selector Missing Component Label

**Symptom**: ~50% of HTTP requests return 502. `kubectl logs` on the app pod
shows no requests arriving. Traefik upstream health checks are passing.

**Root Cause**: PostgreSQL shares the namespace. Service with only `app` label
matches both the app pod and the postgres pod. Traefik load-balances across both.

**Fix**: Add `app.kubernetes.io/component: web` to all Deployment pod labels
and the Service selector.

**Prevention**: Instruction file now requires both labels on every Deployment.
```

After 20-30 incidents, this file becomes a high-signal database that prevents whole categories of recurring mistakes. The AI reads it (via the Memory Protocol instruction) before touching infrastructure.

## Context Management in Practice

Here is the thing nobody tells you when you start with AI coding tools: **context management is a skill you have to develop**.

The AI does not know what is important. It weights everything in the context window roughly equally. If you give it 10,000 tokens of irrelevant file contents and 500 tokens describing the actual problem, do not be surprised when the answer reflects a poor signal-to-noise ratio.

### Good Context Hygiene

**Close files you are not working on.** VS Code sends open editor tabs to Copilot. If you have 15 tabs open, 14 of which are unrelated, you are burning context budget.

**Use `#file` references deliberately.** When you reference a file in chat, include only the file that is actually relevant to your question. Not the entire `kubernetes/` directory.

**Start fresh for context-heavy tasks.** If you have been debugging a 502 error for 45 minutes in a single chat session and the conversation is full of red herrings, start a new chat with a clean problem statement. The accumulated failed attempts in the conversation history are hurting you, not helping.

**Be explicit about what the AI should ignore.** "Ignore the commented-out sections" is a legitimate prompt instruction.

**Smaller, focused questions outperform giant vague ones.** "Debug my cluster" is a waste of tokens. "The readiness probe on the app pod is failing after a redeploy. Here are the events: `[events]`. What is the most likely cause?" gives the model something to work with.

### The Context-vs-Model Tradeoff

This is the counterintuitive insight: for most tasks, you are better off with Sonnet and excellent context than Opus and mediocre context. The quality of your input matters more than the power of the model.

Save Opus for the problems where you genuinely need deeper reasoning — architectural decisions, complex failure analysis across multiple systems, generating something from scratch that requires creative problem-solving. For "write the Deployment manifest for my new service", Sonnet with your instruction files loaded is sufficient and significantly faster.

## Starting From Scratch: Day One Setup

If you just bought Copilot, here is the shortest path to something functional:

### Step 1: Write the instructions file

Create `.github/copilot-instructions.md` in your main repository. Write three sections:

1. **What is this project**: 3-5 sentences describing the tech stack and purpose.
2. **Conventions**: The 5-10 rules that matter most for your codebase.
3. **Anti-patterns**: The 3-5 mistakes you have already made or want to avoid.

Keep it under 100 lines. You can always add more.

### Step 2: Pick two path-scoped instruction files

Start with the two file types you work with most. If you do a lot of Kubernetes and Python, create `kubernetes.instructions.md` and `python.instructions.md`. Do not create 10 files on day one — you do not know yet what needs scoped instructions.

### Step 3: Make your first skill

Pick the most complex recurring task in your workflow. The one where you always have to look up the steps, check a runbook, or copy from a previous implementation. Write that procedure as a skill file. Next time you need to do it, have Copilot load the skill and walk you through it.

### Step 4: Start the lessons database

After your first significant mistake (or prevented mistake), create `docs/ai-lessons.md` with one entry. Add to it every time something goes wrong. 

### Step 5: Run one week, then adjust

After a week, look at where Copilot helped and where it did not. The answer usually points at gaps in the instruction system. Add what is missing.

## The Honest Expectations Section

AI tools will not make you 10x faster on day one. That number is marketing. Here is what actually happens:

**Week 1-2**: Learning the tool, prompt patterns, understanding what it handles well. You might be slower than normal because you are adjusting workflows.

**Week 3-4**: You have the basic instruction system set up. Boilerplate generation is fast. Explanations are helpful. You are spending less time on syntax and more on architecture.

**Month 2+**: The instruction system has accumulated real knowledge about your project. The AI stops making the same mistakes. It generates code that fits your patterns without you having to explain them. This is when the productivity gains become real.

**The failure mode** is getting frustrated in week 1 and concluding AI coding tools do not work. They require investment to set up properly, like any tool.

## Lessons I Learned Doing This Wrong First

I set up Copilot without any instructions and wondered why it kept suggesting NGINX Ingress in a cluster where Traefik is the sole ingress controller. It kept generating arm64 Docker builds for a cluster that is amd64-only. It kept creating PostgreSQL configs without considering Longhorn's storage constraints.

Every one of those mistakes was my fault, not the model's. The model had no way to know. Once I added those constraints to the instruction system, they stopped.

The biggest lesson: **treat every AI mistake as a documentation failure, not a model failure.** If the AI did something wrong that it could have done right with the right context, add that context to the instruction system. The cost is 10 minutes of writing. The benefit is that mistake never happens again.

## What's Next

The system described here is not an endpoint — it is a starting point. Once you have the basics working:

- **Add repository cross-links**: If you work across multiple repositories, your skills and lessons database can reference each other. A blog repository's content generation skill can reference the infrastructure repository's deployment process.
- **Automate lessons capture**: After a major incident, run a Copilot prompt that helps you draft the lessons database entry while the context is fresh.
- **Review the instructions quarterly**: Projects evolve. Anti-patterns get fixed at the source. Conventions change. The instruction files need maintenance or they drift from reality and start sending the AI in wrong directions.

The goal is not a perfect system on day one. It is a system that gets slightly better every week, accumulating knowledge in a form the AI can actually use.

---

*Related: [AI-Assisted Infrastructure: Claude, Copilot, and the Memory Protocol](/posts/2026-02-22-ai-assisted-infrastructure/) covers the full AI toolchain for homelab infrastructure, and [Building an AI Memory System](/posts/2026-02-26-ai-memory-system/) traces the three generations of instruction architecture.*
