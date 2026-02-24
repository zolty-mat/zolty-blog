---
name: blog-infrastructure
description: Manage the AWS infrastructure for the blog including CloudFront, S3, Route53, ACM, and Terraform. Use when asked to modify CDN settings, DNS records, TLS certificates, WAF rules, S3 bucket policies, or run Terraform for the blog. Covers the CloudFront + S3 static hosting architecture, CI/CD deployment, and infrastructure-as-code.
keywords: terraform, cloudfront, s3, route53, acm, cdn, dns, tls, waf, infrastructure, deploy, aws
---

# Blog Infrastructure

Manage AWS infrastructure for the static blog: CloudFront + S3 + Route53 + ACM.

## When to Use This Skill

- Modifying CloudFront distribution settings
- Updating DNS records or TLS certificates
- Changing S3 bucket policies or CORS
- Running Terraform plan/apply for the blog
- Debugging deployment or CDN issues

## Architecture

```
User → CloudFront (CDN) → S3 Bucket (static HTML)
         ↳ ACM cert (us-east-1)
         ↳ Route53 DNS (blog.zolty.systems)
         ↳ WAF (if enabled)
```

## Terraform

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

**State**: S3 bucket `k3s-homelab-tfstate-855878721457`, key `zolty-blog/terraform.tfstate`

### Key Resources

| Resource | Purpose |
|---|---|
| S3 bucket | Static site hosting |
| CloudFront distribution | CDN with HTTPS |
| ACM certificate | TLS (must be `us-east-1` for CloudFront) |
| Route53 records | DNS for `blog.zolty.systems` |
| IAM user | CI/CD deploy permissions |

## Deployment Pipeline

1. Push to `main` with changes in `hugo/**`
2. GitHub Actions builds with `hugo --minify --environment production`
3. Two-pass S3 sync:
   - HTML/XML/JSON → 1 hour cache
   - Static assets (CSS/JS/images) → 1 year immutable cache
4. CloudFront invalidation (`/*`)

## CI/CD Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| Deploy | Push to main (`hugo/**`) | Build + S3 sync + CloudFront invalidation |
| Terraform | Push to main (`terraform/`) | Auto-apply infrastructure changes |
| Generate Content | Manual / weekly schedule | Bedrock article generation → PR |

All run on self-hosted ARC runners: `[self-hosted, k3s, linux, amd64]`

## Critical Rules

- ACM certificate MUST be in `us-east-1` (CloudFront requirement)
- Never commit `terraform.tfvars` or `*.tfstate`
- CI/CD secrets are repo-level (org-level don't work with ARC)
- Git commits use `zolty <zolty@zolty.systems>` identity

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Site not updating | CloudFront cache | Check invalidation ran |
| TLS error | ACM cert in wrong region | Must be `us-east-1` |
| Deploy fails | Expired AWS creds | Check repo secret `AWS_ACCESS_KEY_ID` |
| Terraform state locked | Stale lock | `terraform force-unlock <ID>` |

## References

- [Terraform Instructions](../../.github/instructions/terraform.instructions.md)
- [CI/CD Instructions](../../.github/instructions/ci-cd.instructions.md)
