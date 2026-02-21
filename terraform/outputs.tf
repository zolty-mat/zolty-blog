output "s3_bucket_name" {
  description = "Blog content S3 bucket name"
  value       = aws_s3_bucket.blog.id
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (needed for cache invalidation)"
  value       = aws_cloudfront_distribution.blog.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain"
  value       = aws_cloudfront_distribution.blog.domain_name
}

output "route53_nameservers" {
  description = "Route53 nameservers -- update your domain registrar with these"
  value       = aws_route53_zone.zolty.name_servers
}

output "blog_ci_access_key_id" {
  description = "Access key for blog CI user"
  value       = aws_iam_access_key.blog_ci.id
}

output "blog_ci_secret_access_key" {
  description = "Secret key for blog CI user"
  value       = aws_iam_access_key.blog_ci.secret
  sensitive   = true
}
