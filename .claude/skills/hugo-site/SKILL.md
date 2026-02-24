---
name: hugo-site
description: Build and manage the Hugo static blog site. Use when asked to create posts, modify layouts, update config, add shortcodes, work with the PaperMod theme, configure Hugo templates, or debug build errors. Covers Hugo page bundles, config files, custom partials, shortcodes, Google Ads/Analytics, and local development.
keywords: hugo, blog, post, layout, template, shortcode, papermod, theme, config, partial, build
---

# Hugo Site Management

Build and manage the zolty-blog Hugo static site with PaperMod theme.

## When to Use This Skill

- Creating new blog posts
- Modifying layouts or partials
- Adding/modifying shortcodes
- Updating Hugo configuration
- Debugging build errors
- Working with Google Ads or Analytics integration

## Site Structure

```
hugo/
├── config/_default/     # Hugo configuration
│   ├── hugo.toml        # Main config
│   ├── params.toml      # Theme parameters
│   ├── menus.toml       # Navigation menus
│   └── markup.toml      # Markdown rendering
├── content/posts/       # Blog articles (page bundles)
├── layouts/
│   ├── partials/        # Custom partials (ads, comments, SEO)
│   └── shortcodes/      # Custom shortcodes (ad, amzn, gear-card)
├── static/              # Static assets
└── themes/PaperMod/     # Theme (submodule)
```

## Creating a New Post

```bash
mkdir -p hugo/content/posts/my-new-article
```

Create `hugo/content/posts/my-new-article/index.md`:

```markdown
---
title: "Article Title"
date: 2026-02-23T12:00:00Z
author: "zolty"
description: "150-160 char SEO description"
tags: ["homelab", "kubernetes"]
categories: ["Infrastructure"]
---

Article content here...
```

- **Images**: Place directly in the page bundle directory (same level as `index.md`)
- **Image format**: JPEG only — convert HEIC with `sips -s format jpeg -s formatOptions 85 input.heic --out output.jpg`

## Custom Shortcodes

| Shortcode | Purpose | Example |
|---|---|---|
| `{{</* ad */>}}` | In-article ad placement | Place between sections |
| `{{</* amzn search="..." */>}}text{{</* /amzn */>}}` | Amazon affiliate link (tag: `zoltyblog07-20`) | Product mentions |
| `{{</* gear-card */>}}` | Styled product recommendation card | Hardware reviews |
| `{{</* youtube VIDEO_ID */>}}` | Embed YouTube video | Video content |

**Warning**: Shortcodes do NOT render inside triple-backtick code blocks.

## Configuration

- **Google Ads/Analytics**: Only rendered in production (`hugo.Environment == "production"`)
- **Giscus comments**: GitHub Discussions-based (no server-side processing)
- **Affiliate disclosure**: Site-wide footer via `layouts/partials/extend_footer.html`

## Local Development

```bash
cd hugo && hugo server --buildDrafts
# Open http://localhost:1313
```

## Build

```bash
cd hugo && hugo --minify --environment production
```

## Deployment

- Push to `main` with changes in `hugo/**` triggers automatic build + deploy
- Two-pass S3 sync: HTML (1hr cache) + static assets (1yr immutable cache)
- CloudFront invalidation after every deploy

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Build fails | Invalid front matter | Check YAML syntax in `index.md` |
| Images not showing | HEIC format | Convert to JPEG |
| Shortcode as literal text | Inside code block | Move outside fenced blocks |
| Ads not showing | Not production build | Use `--environment production` |
| Theme changes lost | PaperMod is a submodule | Override in `layouts/`, don't edit theme |

## References

- [Content Instructions](../../.github/instructions/content.instructions.md)
- [Layouts Instructions](../../.github/instructions/layouts.instructions.md)
