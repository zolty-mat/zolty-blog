data "aws_caller_identity" "current" {}

# ── S3 Bucket for blog content ──────────────────────────────────────────

resource "aws_s3_bucket" "blog" {
  bucket = "zolty-blog-content-${data.aws_caller_identity.current.account_id}"
  tags = {
    ManagedBy = "terraform"
    Project   = "zolty-blog"
  }
}

resource "aws_s3_bucket_versioning" "blog" {
  bucket = aws_s3_bucket.blog.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "blog" {
  bucket = aws_s3_bucket.blog.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "blog" {
  bucket                  = aws_s3_bucket.blog.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "blog" {
  bucket = aws_s3_bucket.blog.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.blog.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.blog.arn
          }
        }
      }
    ]
  })
}

# ── CloudFront Distribution ─────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "blog" {
  name                              = "zolty-blog-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "blog" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  aliases             = ["blog.zolty.systems"]
  comment             = "zolty.systems blog"

  origin {
    domain_name              = aws_s3_bucket.blog.bucket_regional_domain_name
    origin_id                = "s3-blog"
    origin_access_control_id = aws_cloudfront_origin_access_control.blog.id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "s3-blog"
    compress         = true

    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized

    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 300
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.blog.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    ManagedBy = "terraform"
    Project   = "zolty-blog"
  }
}

# ── Security Headers ────────────────────────────────────────────────────

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "zolty-blog-security-headers"
  comment = "Security headers for zolty.systems blog"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://pagead2.googlesyndication.com https://partner.googleadservices.com https://tpc.googlesyndication.com https://giscus.app; style-src 'self' 'unsafe-inline' https://giscus.app; img-src 'self' data: https:; frame-src https://giscus.app https://googleads.g.doubleclick.net https://tpc.googlesyndication.com; connect-src 'self' https://www.google-analytics.com https://pagead2.googlesyndication.com"
      override                = true
    }
  }
}

# ── Route53 ──────────────────────────────────────────────────────────────

resource "aws_route53_zone" "zolty" {
  name = "zolty.systems"
  tags = {
    ManagedBy = "terraform"
    Project   = "zolty-blog"
  }
}

resource "aws_route53_record" "blog_a" {
  zone_id = aws_route53_zone.zolty.zone_id
  name    = "blog.zolty.systems"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.blog.domain_name
    zone_id                = aws_cloudfront_distribution.blog.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "blog_aaaa" {
  zone_id = aws_route53_zone.zolty.zone_id
  name    = "blog.zolty.systems"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.blog.domain_name
    zone_id                = aws_cloudfront_distribution.blog.hosted_zone_id
    evaluate_target_health = false
  }
}

# ── Google Search Console verification ───────────────────────────────────

resource "aws_route53_record" "google_search_console" {
  zone_id = aws_route53_zone.zolty.zone_id
  name    = "zolty.systems"
  type    = "TXT"
  ttl     = 300
  records = ["google-site-verification=rbadzUQ-CuI_TYz20uzR57AhBL2S93je1QGIC_U6Ls8"]
}

# ── ACM Certificate (must be us-east-1 for CloudFront) ──────────────────

resource "aws_acm_certificate" "blog" {
  provider                  = aws.us_east_1
  domain_name               = "blog.zolty.systems"
  subject_alternative_names = ["zolty.systems"]
  validation_method         = "DNS"

  tags = {
    ManagedBy = "terraform"
    Project   = "zolty-blog"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.blog.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id = aws_route53_zone.zolty.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "blog" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.blog.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ── IAM for CI/CD (blog deploy + Bedrock) ────────────────────────────────

resource "aws_iam_user" "blog_ci" {
  name = "zolty-blog-ci"
  path = "/system/"
  tags = {
    ManagedBy = "terraform"
    Project   = "zolty-blog"
    Purpose   = "CI/CD for blog deploy and content generation"
  }
}

resource "aws_iam_access_key" "blog_ci" {
  user = aws_iam_user.blog_ci.name
}

resource "aws_iam_user_policy" "blog_ci" {
  name = "zolty-blog-ci-policy"
  user = aws_iam_user.blog_ci.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3BlogSync"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.blog.arn,
          "${aws_s3_bucket.blog.arn}/*"
        ]
      },
      {
        Sid    = "CloudFrontInvalidate"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
          "cloudfront:ListInvalidations"
        ]
        Resource = aws_cloudfront_distribution.blog.arn
      },
      {
        Sid    = "BedrockInvokeModel"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = [
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.*",
          "arn:aws:bedrock:us-east-1:${data.aws_caller_identity.current.account_id}:inference-profile/*"
        ]
      },
      {
        Sid    = "BedrockListModels"
        Effect = "Allow"
        Action = [
          "bedrock:ListFoundationModels",
          "bedrock:GetFoundationModel"
        ]
        Resource = "*"
      }
    ]
  })
}
