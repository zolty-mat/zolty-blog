---
title: "This Blog Deploys Itself: Self-Hosted CI/CD on k3s with GitHub ARC"
date: 2026-03-18T20:00:00-06:00
draft: false
author: "zolty"
description: "How the blog deploys itself using self-hosted GitHub Actions runners inside the k3s cluster — scheduled posts, Bedrock content generation, and Playwright scanning after every push."
tags: ["ci-cd", "k3s", "github-actions", "arc", "hugo", "homelab", "devops"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "CI/CD pipeline for blog deployment on k3s"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

The blog is deployed by GitHub Actions runners running inside the same k3s cluster it's talking about. A push to `main` with content under `hugo/` triggers a build, a two-pass S3 sync, and a CloudFront invalidation. A daily 06:00 UTC cron handles future-dated posts so I can commit a backlog and let them drip out on schedule. After every successful deploy, a Playwright job kicks off and scans the live site for broken links, visual regressions, and security header compliance. The whole thing runs on eight self-hosted amd64 runners managed by GitHub's Actions Runner Controller (ARC) in the cluster. Not a single managed CI minute gets billed.

## The Setup

The blog is a Hugo static site. Content lives in a GitHub repo (`zolty-mat/zolty-blog`). When I merge something to `main`, GitHub dispatches a workflow run. Instead of that run going to GitHub's hosted runners, it goes to the ARC runner pool sitting in k3s. The runner picks it up, builds the site, pushes to S3, and invalidates CloudFront. The whole thing takes about 90 seconds.

This is the same k3s cluster I've been building out in most of the other posts here. Eight amd64 runners scaled 8-12 based on demand, all running on the worker nodes. The blog CI is one of a dozen or so workflows using this pool — it's the same runners that build and deploy Cardboard, the trade bot, the media stack, all of it.

## The Deploy Workflow

Three triggers:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'hugo/**'
      - '.github/workflows/deploy.yml'
  workflow_dispatch:
  schedule:
    - cron: '0 6 * * *'
```

The `paths` filter on the push trigger means a terraform change or a docs update doesn't trigger a rebuild. Only actual content changes or workflow changes do. `workflow_dispatch` lets me kick a deploy manually when needed. The `schedule` is what makes the backlog approach work — more on that below.

The build step itself is straightforward:

```yaml
- name: Setup Hugo
  uses: peaceiris/actions-hugo@v3
  with:
    hugo-version: '0.156.0'
    extended: true

- name: Build site
  working-directory: hugo
  run: hugo --minify --environment production
```

Hugo version is pinned, not floating. Pinning versions in CI is one of those things that seems annoying until you get burned by a surprise breaking change on a Saturday.

### Two-Pass S3 Sync

The sync is split into two passes with different cache-control headers:

```yaml
- name: Sync HTML/XML/JSON to S3 (short cache)
  run: |
    aws s3 sync hugo/public/ s3://$S3_BUCKET/ \
      --exclude "*" \
      --include "*.html" --include "*.xml" --include "*.json" --include "*.txt" \
      --cache-control "public, max-age=3600" \
      --delete

- name: Sync static assets to S3 (long cache)
  run: |
    aws s3 sync hugo/public/ s3://$S3_BUCKET/ \
      --exclude "*.html" --exclude "*.xml" --exclude "*.json" --exclude "*.txt" \
      --cache-control "public, max-age=31536000, immutable" \
      --delete
```

HTML, feeds, and JSON get a 1-hour cache. CSS, JS, images, and fonts get a 1-year immutable cache. The reasoning: content changes with every deploy, but assets are fingerprinted by Hugo so a new filename means a new file. Long-caching assets is free performance. Short-caching HTML means readers get new content within an hour even if there's no explicit invalidation.

After both syncs, a CloudFront `/*` invalidation clears everything:

```yaml
- name: Invalidate CloudFront cache
  run: |
    aws cloudfront create-invalidation \
      --distribution-id $CLOUDFRONT_DISTRIBUTION_ID \
      --paths "/*"
```

## Scheduled Posts Without Any Tooling

Hugo excludes posts with a future `date` from the build by default. That one behavior makes a simple pattern possible: commit posts with future dates, let the daily cron handle publication.

Right now the pipeline has posts queued into March and beyond. I commit them to `main`, they sit in the repo, and at 06:00 UTC each day the scheduled workflow fires, Hugo builds with the current date as the cutoff, and any post whose date has arrived goes live. No manual trigger, no CMS, no publication queue to manage. The repo is the queue.

The only thing to remember is that `draft: false` has to be set in the front matter. A post with `draft: true` never publishes regardless of date.

## Content Generation

There's a separate workflow for generating article drafts via AWS Bedrock:

```yaml
name: Generate Blog Content

on:
  workflow_dispatch:
    inputs:
      topic:
        description: 'Article topic'
        required: true
  schedule:
    - cron: '0 9 * * 1'  # Mondays at 09:00 UTC
```

Manual dispatch takes a topic and any context notes. The Monday schedule pulls from a backlog of topics in `content-gen/prompts/topics.json`. Either way, a Python script calls Bedrock (Claude), generates a Hugo page bundle, and the workflow opens a PR rather than merging directly to `main`. The PR-for-review gate is intentional — generated content needs editing before it goes out.

Merging that PR triggers the deploy workflow. The chain from generation to live site is: Bedrock → PR → human review → merge → ARC runner → S3 → CloudFront.

## Post-Deploy Site Scanning

Every successful deploy triggers a Playwright scan of the live site:

```yaml
on:
  workflow_run:
    workflows: ["Deploy Blog"]
    types: [completed]
    branches: [main]
```

The scan runs three jobs: visual regression testing against stored baselines, a broken link check across the full site, and a security headers audit. If the deploy workflow didn't succeed, the scan gates itself and skips:

```yaml
- name: Evaluate run conditions
  id: gate
  run: |
    if [[ "${{ github.event_name }}" == "workflow_run" ]]; then
      CONCLUSION="${{ github.event.workflow_run.conclusion }}"
      if [[ "$CONCLUSION" != "success" ]]; then
        echo "should_run=false" >> $GITHUB_OUTPUT
      else
        echo "should_run=true" >> $GITHUB_OUTPUT
      fi
    fi
```

The visual regression tests compare screenshots against committed baselines. When they fail it usually means a layout change I didn't notice, a CSS regression from a theme update, or occasionally a real rendering bug. Having this run automatically after every deploy means I catch things before readers report them.

The security headers check covers the basics: `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `X-Content-Type-Options`. CloudFront adds most of these but the scan catches any that drift.

## The ARC Runner Setup

The runners themselves are managed by GitHub's Actions Runner Controller, deployed via Helm into `arc-runner-system`. Eight replicas, scaling up to 12 under load:

```yaml
runs-on: [self-hosted, k3s, linux, amd64]
```

That label set is what routes blog workflow jobs to the cluster runners instead of GitHub's hosted fleet. The `self-hosted` label has to be explicit — ARC's `labels` field replaces defaults entirely, it doesn't append. That one bit me early on and it's now in the lessons database.

Runner secrets are repo-level. Org-level secrets don't work with ARC runners — something about how the token scoping works with the summerwind chart. Blog AWS credentials (`BLOG_AWS_ACCESS_KEY_ID`, `BLOG_AWS_SECRET_ACCESS_KEY`), the S3 bucket name, and the CloudFront distribution ID are all stored as repo secrets.

## Why Self-Hosted

The honest answer is mostly cost and control. GitHub's hosted runners bill per minute. The blog runs enough workflows — deploys, content generation, weekly Playwright scans — that the minutes would add up. The cluster already exists. Running eight runners on it costs nothing beyond the electricity that was already being consumed.

The other reason is that the runners share the cluster's network. When a runner needs to hit an internal service for something — say, the media library API to pull image metadata during content generation — it can do that directly without any VPN or external exposure. That's harder to arrange with hosted runners.

The tradeoff is maintenance. The ARC installation needs periodic updates, the runner image gets stale, occasionally a runner pod gets stuck and needs recycling. It's not zero overhead. But it's low overhead, and it's the same Kubernetes operations I'm doing for everything else in the cluster anyway.

## What I'd Do Differently

The biggest thing: I'd set up the daily cron and the backlog approach from day one instead of doing manual pushes for each post. I spent the first few weeks pushing posts individually as I wrote them, which meant the blog went dark when I was busy. The scheduled approach decouples writing from publishing and that's the right model.

I'd also set up the Playwright baselines earlier. The visual regression tests are only useful once the baselines exist and are committed, and I didn't bother until the site was a month old. Running a scan against a site with no baselines just generates noise.

The content generation workflow is the piece I'm still iterating on. The generated drafts are usable but they need editing — they tend to be longer and more structured than my actual writing style. I've been tweaking the system prompt in `content-gen/prompts/article-system.txt` but there's no fast path to getting an LLM to write exactly like you. The workflow is useful for getting a skeleton and a research base. The actual voice still has to be applied manually.

---

*The ARC runner setup is covered in more detail in [Self-Hosted CI/CD with GitHub ARC on k3s](/posts/2026-02-12-self-hosted-cicd/). The blog infrastructure — S3, CloudFront, cert-manager — is Terraform-managed and lives alongside the cluster infrastructure.*
