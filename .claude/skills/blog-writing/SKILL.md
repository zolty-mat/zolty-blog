---
name: blog-writing
description: Write and edit blog articles for zolty-blog with consistent voice, structure, and SEO optimization. Use when drafting new posts, editing existing content, improving readability, writing introductions/conclusions, or optimizing articles for search. Covers the zolty writing voice, article structure patterns, SEO best practices, and affiliate integration guidelines.
keywords: write, blog, article, post, draft, edit, seo, content, tone, voice, headline, introduction
---

# Blog Writing

Write and edit articles for blog.zolty.systems with consistent voice, structure, and SEO quality.

## When to Use This Skill

- Drafting a new blog article from scratch or outline
- Editing or improving an existing article
- Writing introductions, conclusions, or TL;DRs
- Optimizing content for SEO (titles, descriptions, headings)
- Reviewing article structure and flow
- Adding affiliate links naturally

## The zolty Voice

### Tone

- **Technical but accessible** — explain complex topics so a motivated intermediate reader can follow
- **First person singular** — "I deployed", "I learned", not "we" or passive voice
- **Direct and honest** — state what happened, what broke, what worked. No corporate hedging
- **Show the work** — include actual commands, configs, error messages. Readers came for specifics
- **Self-deprecating humor is OK** — "I spent 45 minutes debugging before realizing I had a typo"
- **No hype or filler** — never "In today's fast-paced world..." or "Let's dive in!"
- **Opinionated** — state preferences and justify them. "Option 3 won because..."

### What zolty Is NOT

- Not a brand or company — zolty is one person running a homelab
- Not an authority figure — zolty is sharing what worked (and what didn't)
- Not writing for beginners — assume readers know what Kubernetes, Docker, and Linux are
- Not writing clickbait — headlines describe content accurately

### Author Identity

- Author is always **"zolty"** — never use real names, email addresses, or PII
- Git commits use `zolty <zolty@zolty.systems>`
- No biographical details beyond "runs a homelab k3s cluster"

## Article Structure

### Standard Pattern

Every article follows this skeleton:

```markdown
---
title: "Descriptive Title That Summarizes the Article"
date: 2026-MM-DDT20:00:00-06:00
draft: false
author: "zolty"
description: "150-160 character SEO description with primary keyword"
tags: ["kubernetes", "specific-topic"]
categories: ["Infrastructure|Applications|Operations|Networking"]
cover:
  image: "/images/covers/category.svg"
  alt: "Cover image description"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

2-4 sentences summarizing what was done, why, and the outcome.
Include key metrics if relevant (RAM usage, cost, time saved).

## Why / Motivation Section

Why this project exists. What problem it solves.
What alternatives were considered and why this approach won.

## Architecture / Design

How the system works at a high level.
ASCII diagrams, component lists, data flow.

## Implementation

Step-by-step walkthrough with actual commands and configs.
Break into logical subsections (## heading per major step).
Include YAML/bash/config blocks — readers want copy-paste.

## Results / Verification

Show it working. Include command output, screenshots, metrics.

## Lessons Learned (optional)

What went wrong. What would be done differently.
Honest retrospectives build trust.

## What's Next (optional)

Brief mention of follow-up work. Links to related posts.
```

### Section Guidelines

| Section | Length | Purpose |
|---------|--------|---------|
| TL;DR | 2-4 sentences | Busy readers get the value immediately |
| Why/Motivation | 3-5 paragraphs | Context and decision rationale |
| Architecture | Varies | Mental model before implementation details |
| Implementation | Longest section | Step-by-step with code blocks |
| Results | 2-4 paragraphs | Proof it works, metrics |
| Lessons | 2-5 bullets | Honesty and credibility |

### Formatting Rules

- **Headings**: Use `##` for major sections, `###` for subsections. Never skip levels.
- **Code blocks**: Always specify language (```bash, ```yaml, ```python, etc.)
- **Bold for emphasis**: Use `**bold**` for key terms on first introduction
- **Lists over prose**: When listing 3+ items, use bullet points
- **One idea per paragraph**: Keep paragraphs to 3-5 sentences max
- **Link to previous posts**: Reference related articles when relevant

## SEO Best Practices

### Title

- 50-65 characters ideal (fits in search results)
- Include primary keyword near the beginning
- Be specific: "GPU Passthrough on k3s with ThinkCentre M920q" > "GPU Setup Guide"
- Use sentence case, not Title Case for every word

### Description (meta)

- Exactly 150-160 characters
- Includes primary keyword
- Summarizes the article's value proposition
- Reads as a complete thought, not a fragment

### Headings (H2/H3)

- Include secondary keywords naturally
- Questions work well: "Why Self-Host AI Chat?"
- Descriptive over clever: "Configuring LiteLLM" > "The Glue Layer"

### Content Quality Signals

- **Length**: 1,500-3,000 words for technical tutorials
- **Completeness**: Cover the topic end-to-end — don't leave readers needing another guide
- **Freshness**: Include version numbers, dates, and specific software versions
- **Internal linking**: Link to related zolty-blog posts where relevant

## Writing Process

### Step 1: Outline

Before writing, create an outline with:
1. Working title
2. Target keyword(s)
3. 5-8 section headings
4. Key code blocks or commands to include
5. Affiliate opportunities (if any hardware/products involved)

### Step 2: Draft

Write the implementation sections first (where the technical meat is),
then the introduction/motivation, then TL;DR last. The TL;DR is easier to
write when you know what the article actually covers.

### Step 3: Review Checklist

Before publishing, verify:

- [ ] Title is 50-65 characters with primary keyword
- [ ] Description is 150-160 characters
- [ ] Author is "zolty" (never real names)
- [ ] TL;DR exists and is concise
- [ ] All code blocks have language specifiers
- [ ] Commands are copy-paste ready (no placeholder values without explanation)
- [ ] Images are JPEG (not HEIC) and have alt text
- [ ] Affiliate links placed naturally (not forced)
- [ ] No secrets, credentials, or real IPs in code examples
- [ ] Internal links to related posts where relevant
- [ ] Table of Contents enabled (`ShowToc: true`)
- [ ] Article reads well top-to-bottom without jumping around

## Affiliate Integration

### When to Include

- Article mentions specific hardware the author owns (ThinkCentre, NAS, NICs, etc.)
- Article recommends a service where DO referral is relevant
- Product is genuinely part of the story, not shoehorned in

### How to Include

```markdown
<!-- Amazon — natural mention in hardware discussion -->
The {{</* amzn search="Lenovo ThinkCentre M920q" */>}}ThinkCentre M920q{{</* /amzn */>}}
draws about 35W at idle, making it ideal for 24/7 cluster nodes.

<!-- DigitalOcean — blockquote callout for non-homelab readers -->
> **Don't have a homelab?** This same architecture works on any Kubernetes
> cluster. A [$200-credit DigitalOcean account](https://www.digitalocean.com/
> ?refcode=b9012919f7ff&utm_campaign=Referral_Invite&utm_medium=Referral_Program
> &utm_source=badge) could run this for a few dollars per month.
```

### Rules

- Never force affiliate links into unrelated content
- Amazon links go where products are **naturally discussed**
- DO callouts go in a blockquote, positioned after explaining the self-hosted approach
- Maximum 2-3 affiliate callouts per article — more feels spammy

## Common Article Types

### Hardware Build / Setup Article

Focus on: specific model numbers, power consumption, gotchas during assembly,
benchmark results, cost breakdown.

### Kubernetes Deployment Tutorial

Focus on: architecture diagram, manifests (full YAML), verification commands,
troubleshooting table at the end.

### Debugging / Incident Report

Focus on: timeline, symptoms, investigation steps, root cause, fix, lessons.
Use the "Top 10 Production Failures" format for listicles.

### Comparison / Decision Article

Focus on: clear criteria, pros/cons table, final decision with reasoning.
"Option 3 won because..." pattern.

## Anti-Patterns

- **Wall of text** — break long sections with code blocks, lists, or subheadings
- **Burying the lede** — TL;DR goes first, not at the bottom
- **Placeholder commands** — `kubectl apply -f <YOUR_FILE>` is useless. Show the actual file
- **Screenshot-only guides** — include text-based commands alongside screenshots
- **Outdated versions** — always specify exact versions used (k3s v1.34.4, not "latest")
- **"Just" or "simply"** — if it were simple, they wouldn't be reading a guide

## References

- [Content Instructions](../../.github/instructions/content.instructions.md)
- [Hugo Site Skill](../hugo-site/SKILL.md) — for Hugo mechanics
- [Content Generation Skill](../content-generation/SKILL.md) — for automated pipeline
