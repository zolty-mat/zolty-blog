---
title: "When Your AI Memory System Eats Its Own Context Window"
date: 2026-02-23T20:00:00-06:00
draft: false
author: "zolty"
description: "A multi-repo AI skill audit found 401KB of duplicated content consuming 100K tokens. Here's how I measured, diagnosed, and fixed context window bloat."
tags: ["ai", "copilot", "claude", "devops", "documentation", "homelab"]
categories: ["Operations"]
cover:
  image: "/images/covers/operations.svg"
  alt: "AI context window audit"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

The AI memory system I [built three weeks ago](/posts/2026-02-26-ai-memory-system/) started causing the problem it was designed to solve: context window exhaustion. Five generic Claude skills — duplicated identically across all 5 repositories in my workspace — consumed 401KB (~100K tokens) of potential context. The `gh-cli` skill alone was 40KB per copy, accounting for 42% of all skill content. I ran a full audit, deleted 25 duplicate files, and documented the anti-pattern to prevent recurrence.

## The Symptom

I noticed context filling fast during normal development sessions. Tasks that used to fit comfortably in a single conversation were hitting limits. Something had changed since the AI memory system was implemented.

The irony was not lost on me: the documentation system designed to make AI sessions more efficient was making them shorter.

## The Three Layers of Context

To understand the problem, you need to know how AI context gets consumed in a multi-repo VS Code workspace. There are three layers, each with different loading behavior:

### Layer 1: Always Loaded (System Prompt)

Every message in every conversation loads these files automatically:

| Source | Size | Notes |
|--------|------|-------|
| 5× `copilot-instructions.md` | ~28KB (~7K tokens) | One per repo, all injected |
| Skill listing (descriptions) | ~3KB (~750 tokens) | Name + description for all 41 skills |
| Instruction file references | ~2KB (~500 tokens) | Paths to 21 `.github/instructions/` files |
| **Total baseline** | **~33KB (~8K tokens)** | **Before you ask a single question** |

This baseline is reasonable. The copilot-instructions files are the operating system for each project. The skill descriptions are short summaries that help the AI decide which skills to load. The instruction file paths are just references.

### Layer 2: Skills (Loaded on Demand)

Claude skills live in `.claude/skills/*/SKILL.md` and are loaded into context when the AI determines they are relevant to the current task. This is where the problem was hiding.

41 skill files across 5 repos. Total potential context: **474KB (~118K tokens)**.

### Layer 3: Instruction Files (Loaded on Demand)

The `.github/instructions/*.md` files with `applyTo` globs are loaded when editing matching file types. These are well-scoped and small — 21 files totaling ~22KB. Not the problem.

## The Audit

I wrote a script to measure every skill file across all 5 repositories, sorted by size:

```bash
find .claude/skills -name "SKILL.md" -exec wc -c {} \; | sort -rn
```

The output made the problem obvious:

```
40494  auto_brand/.claude/skills/gh-cli/SKILL.md
40494  cardboard/.claude/skills/gh-cli/SKILL.md
40494  home_k3s_cluster/.claude/skills/gh-cli/SKILL.md
40494  trade_bot/.claude/skills/gh-cli/SKILL.md
40494  zolty-blog/.claude/skills/gh-cli/SKILL.md
16843  auto_brand/.claude/skills/refactor/SKILL.md
16843  cardboard/.claude/skills/refactor/SKILL.md
16843  home_k3s_cluster/.claude/skills/refactor/SKILL.md
...
```

Five files. Identical content. 40KB each. The `gh-cli` skill was an exhaustive reference for the GitHub CLI — useful in theory, devastating to context budgets in practice.

The same pattern repeated for 4 other generic skills:

| Skill | Per Copy | Copies | Total | Waste (4 extras) |
|-------|----------|--------|-------|-------------------|
| `gh-cli` | 40 KB | 5 | 200 KB | 160 KB |
| `refactor` | 16 KB | 5 | 84 KB | 67 KB |
| `systematic-debugging` | 10 KB | 5 | 49 KB | 39 KB |
| `test-driven-development` | 10 KB | 5 | 49 KB | 39 KB |
| `git-commit` | 3 KB | 5 | 16 KB | 13 KB |
| **Total** | **80 KB** | | **401 KB** | **321 KB (~80K tokens)** |

321KB of pure duplication. Byte-for-byte identical files, verified with `diff`:

```bash
for skill in gh-cli refactor systematic-debugging test-driven-development git-commit; do
  ref="auto_brand/.claude/skills/$skill/SKILL.md"
  for repo in cardboard home_k3s_cluster trade_bot zolty-blog; do
    diff -q "$ref" "$repo/.claude/skills/$skill/SKILL.md"
  done
done
# No output — all identical
```

{{< ad >}}

## Why This Happened

When I set up Claude skills for the workspace, the tooling created generic skills in every repository independently. Each repo got its own copy of `gh-cli`, `refactor`, `systematic-debugging`, `test-driven-development`, and `git-commit`. These are repository-agnostic — they do not contain project-specific knowledge.

In a single-repo workflow, this is fine. A 40KB skill file in one repo is manageable.

In a **multi-repo workspace with 5 repositories open simultaneously**, every copy is visible to the AI. When I ask anything related to git, the AI potentially loads 5 copies of the same 40KB file. That is 200KB of identical content competing for the same context window.

The project-specific skills — `k3s-debugging` (6KB), `price-scraping` (4KB), `trading-strategy` (3KB) — were small and unique to their repos. No duplication, no waste. These are exactly the skills that belong in `.claude/skills/`.

## The Fix

The fix was straightforward: delete all 5 generic skills from all 5 repos, keeping only project-specific skills.

```bash
for repo in auto_brand cardboard home_k3s_cluster trade_bot zolty-blog; do
  for skill in gh-cli refactor systematic-debugging test-driven-development git-commit; do
    rm -rf "$repo/.claude/skills/$skill"
  done
done
```

25 directories deleted. 401KB of context freed.

What remained were the 16 project-specific skills that actually justify their context cost:

| Repository | Skills Retained |
|------------|-----------------|
| `auto_brand` | helm-deployment, pipeline-development, video-generation |
| `cardboard` | portfolio-tracking, price-scraping |
| `home_k3s_cluster` | docker-ecr, grafana-dashboards, k3s-debugging, k3s-deployment, terraform-infra |
| `trade_bot` | ai-predictions, trading-strategy |
| `zolty-blog` | blog-infrastructure, blog-writing, content-generation, hugo-site |

Total retained: ~72KB — all unique, all project-specific.

## The New Rule

I added this to `docs/ai-lessons.md` to prevent recurrence:

> **Generic skills duplicated across repos waste context**: In a multi-repo workspace, generic skills (gh-cli, refactor, systematic-debugging, test-driven-development, git-commit) were identically duplicated across all repos — 25 files totaling ~401KB (~100K tokens). Fix: removed all generic skills. Only project-specific skills belong in repos. If generic skills are needed again, keep them in ONE repo only, never duplicate across a multi-repo workspace.

And updated the `agent-skills.instructions.md` to include:

> **Only project-specific skills belong in repos** — generic skills (gh-cli, refactor, git-commit, etc.) were removed to avoid context window waste in multi-repo workspaces. Do not re-add them.

## Context Budget After

| Category | Before | After | Saved |
|----------|--------|-------|-------|
| Always-loaded baseline | ~33KB | ~33KB | — |
| Skill files (total) | ~474KB | ~72KB | **401KB** |
| Instruction files | ~22KB | ~22KB | — |
| **Total potential context** | **~529KB** | **~127KB** | **76% reduction** |

The always-loaded baseline did not change — those copilot-instructions files are earning their keep. The instruction files are path-scoped and well-sized. The savings came entirely from eliminating duplicated generic skills.

## Lessons Learned

1. **Measure before optimizing.** The symptom was "context fills fast." Without `wc -c` and `diff`, I might have guessed wrong about the cause. The actual data showed that 85% of skill content was generic duplicates.

2. **Multi-repo workspaces multiply everything.** One 40KB file is manageable. Five copies of it across a workspace creates a 200KB problem. Any per-repo resource — skills, instructions, configs — gets multiplied by the number of open repos.

3. **Generic skills have a poor value/cost ratio.** A 40KB `gh-cli` reference covering every subcommand costs 10K tokens per load. The AI already knows `gh` well enough for 99% of tasks. Project-specific skills like `k3s-debugging` (6KB) encode knowledge the AI genuinely does not have.

4. **Documentation systems need periodic audits.** The AI memory system was three weeks old when it started hurting performance. Documentation grows organically — someone needs to occasionally count the bytes.

5. **The AI memory system post said redundancy is intentional for critical rules.** That is still true. The service selector trap appears in 4 files on purpose. But there is a difference between *strategic redundancy* (the same critical rule in multiple contexts) and *accidental duplication* (the same 40KB reference file copied 5 times). One is defense in depth. The other is waste.

## What's Next

The multi-repo workspace still loads 5 separate `copilot-instructions.md` files (~28KB baseline). For sessions focused on a single project, a per-project VS Code workspace would cut that to ~6KB. I have not done this yet because cross-repo work (deploying a cardboard change involves editing k3s manifests) is common enough that the convenience of a single workspace outweighs the cost.

If context pressure returns, that is the next lever to pull.
