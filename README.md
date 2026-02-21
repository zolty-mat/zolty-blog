# zolty-blog

Source repository for [blog.zolty.systems](https://blog.zolty.systems/) — a homelab and infrastructure blog.

## Stack

- **Hugo** + PaperMod theme for static site generation
- **AWS CloudFront + S3** for CDN delivery
- **AWS Bedrock** (Claude 3.5 Sonnet) for AI-assisted content generation
- **Terraform** for infrastructure management
- **GitHub Actions** on self-hosted k3s runners for CI/CD
- **Giscus** for comments (GitHub Discussions)
- **Google Analytics** + **Google AdSense** for analytics and monetization

## Local Development

```bash
cd hugo
hugo server --buildDrafts
```

Open http://localhost:1313 to preview the site.

## Deployment

Push to `main` with changes in `hugo/**` triggers automatic deployment:
1. Hugo builds the site with `--minify`
2. Static files sync to S3 with appropriate cache headers
3. CloudFront cache is invalidated

## Content Generation

Generate article drafts via the GitHub Actions `generate-content` workflow:
1. Go to Actions > Generate Blog Content
2. Enter a topic and optional notes
3. A PR is created with the generated draft
4. Review, edit, and merge to publish

## Infrastructure

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

Manages: S3 bucket, CloudFront distribution, Route53 DNS, ACM certificate, IAM CI user.
