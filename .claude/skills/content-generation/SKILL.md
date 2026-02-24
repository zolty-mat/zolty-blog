---
name: content-generation
description: Generate blog articles using AWS Bedrock (Claude) and the content generation pipeline. Use when asked to create articles, modify the generation workflow, update system prompts, work with the media library integration, or debug content generation failures. Covers Bedrock article generation, Hugo page bundles, media library queries, and the PR-based review workflow.
keywords: article, generate, bedrock, claude, content, blog, post, writing, prompt, media library
---

# Content Generation

Generate blog articles using AWS Bedrock and the automated content pipeline.

## When to Use This Skill

- Generating a new blog article
- Modifying generation prompts or parameters
- Integrating media library images into articles
- Debugging content generation failures
- Working with the GitHub Actions workflow

## Generation Pipeline

1. Topic provided (manual or from `topics.json` backlog)
2. Media library queried for relevant images
3. System prompt + topic sent to Bedrock (Claude 3.5 Sonnet)
4. Response parsed into Hugo page bundle (directory + `index.md`)
5. PR opened for review

## Key Files

| File | Purpose |
|---|---|
| `content-gen/scripts/generate_article.py` | Main generation script |
| `content-gen/prompts/article-system.txt` | System prompt for article style |
| `content-gen/prompts/topics.json` | Topic backlog for scheduled runs |

## Bedrock Configuration

- **Model**: `anthropic.claude-3-5-sonnet-20241022-v2:0`
- **Region**: `us-east-1`
- **Media Library**: `https://media-library.k3s.internal.strommen.systems`

## Hugo Page Bundle Output

Articles are created as page bundles:

```
hugo/content/posts/my-article/
├── index.md          # Article content with front matter
└── (images)          # Co-located images (JPEG only)
```

### Required Front Matter

```yaml
---
title: "Article Title"
date: 2026-02-23T12:00:00Z
author: "zolty"           # ALWAYS "zolty" — never real names
description: "150-160 character description for SEO"
tags: ["homelab", "kubernetes"]
categories: ["Infrastructure"]
---
```

## Media Library Integration

```python
# Query for relevant images
tags = extract_topic_tags(topic)  # e.g., ["kubernetes", "cluster"]
media_items = query_media_library(tags, limit=5)

# Returns Hugo figure shortcodes
# {{< figure src="cdn_url" alt="..." caption="..." >}}
```

## Critical Rules

- **Author is always "zolty"** — never use real names or PII
- **HEIC → JPEG conversion** required — Hugo/browsers don't render HEIC
  ```bash
  sips -s format jpeg -s formatOptions 85 input.heic --out output.jpg
  ```
- **Images go in page bundle directory** (same level as `index.md`)
- **Shortcodes don't render inside code blocks** — `{{< amzn >}}` in triple backticks is literal text
- **No secrets in code** — AWS keys in GitHub Actions secrets only

## Affiliate Integration

- **Amazon Associates**: Tag `zoltyblog07-20`, shortcode `{{< amzn search="..." >}}`
- **DigitalOcean**: Referral code `b9012919f7ff`
- Place affiliate links only where products are naturally mentioned

## GitHub Actions Workflow

- `generate-content.yml` — trigger with topic, creates PR
- Weekly scheduled runs pull from `topics.json` backlog
- Builds with `hugo --buildDrafts` to verify before merge

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Generation fails | Bedrock API error | Check AWS creds, model availability |
| Images not rendering | HEIC format | Convert to JPEG with `sips` |
| Shortcode literal text | Inside code block | Move shortcode outside fenced blocks |
| Media library unreachable | Service down | Non-fatal — article generates without images |

## References

- [Content Instructions](../../.github/instructions/content.instructions.md)
- [Layouts Instructions](../../.github/instructions/layouts.instructions.md)
