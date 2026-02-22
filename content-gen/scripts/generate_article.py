#!/usr/bin/env python3
"""Generate blog articles using AWS Bedrock (Claude 3.5 Sonnet)."""

import json
import os
import re
import boto3
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

BEDROCK_MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0"
BEDROCK_REGION = "us-east-1"
MEDIA_LIBRARY_URL = os.environ.get(
    "MEDIA_LIBRARY_URL",
    "https://media-library.k3s.internal.strommen.systems"
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
HUGO_CONTENT = REPO_ROOT / "hugo" / "content" / "posts"
PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"


def load_system_prompt() -> str:
    return (PROMPTS_DIR / "article-system.txt").read_text()


def query_media_library(tags: list[str], limit: int = 5) -> list[dict]:
    """Query the media library API for images matching the topic tags."""
    try:
        params = f"tags={','.join(tags)}&type=image&limit={limit}"
        url = f"{MEDIA_LIBRARY_URL}/api/search?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print(f"Media library query failed (non-fatal): {e}")
        return []


def format_media_context(media_items: list[dict]) -> str:
    """Format media items into context for the article prompt."""
    if not media_items:
        return ""

    lines = [
        "",
        "Available images from the media library (use Hugo figure shortcodes to embed relevant ones):"
    ]
    for item in media_items:
        cdn_url = item.get("cdn_url", "")
        alt = item.get("alt_text", item.get("filename", ""))
        desc = item.get("ai_description", "")
        tags = ", ".join(item.get("user_tags", []))
        lines.append(f'- {{{{< figure src="{cdn_url}" alt="{alt}" caption="{desc[:100]}" >}}}}')
        lines.append(f"  Tags: {tags}")
    lines.append("")
    lines.append("Only include images that are directly relevant to the article topic. Do not include all of them.")
    return "\n".join(lines)


def extract_topic_tags(topic: str) -> list[str]:
    """Extract likely search tags from a topic string."""
    stop_words = {"a", "an", "the", "and", "or", "for", "on", "in", "to", "with", "how", "why", "my", "i"}
    words = re.sub(r"[^a-z0-9\s-]", "", topic.lower()).split()
    return [w for w in words if w not in stop_words and len(w) > 2][:5]


def generate_article(topic: str, notes: str = "") -> str:
    client = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

    system_prompt = load_system_prompt()

    # Query media library for relevant images
    tags = extract_topic_tags(topic)
    media_items = query_media_library(tags)
    media_context = format_media_context(media_items)

    user_prompt = f"""Write a comprehensive blog article about: {topic}

Additional context and key points to cover:
{notes if notes else 'None provided -- use your best judgment based on the infrastructure context.'}
{media_context}
Output the article as a complete Hugo page bundle index.md file with YAML front matter.
Do not wrap the output in markdown code fences -- output the raw file content directly."""

    response = client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 8192,
            "system": system_prompt,
            "messages": [
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0.7,
        }),
    )

    result = json.loads(response["body"].read())
    return result["content"][0]["text"]


def pick_scheduled_topic() -> tuple[str, str] | None:
    topics_file = PROMPTS_DIR / "topics.json"
    topics = json.loads(topics_file.read_text())
    pending = [t for t in topics if not t.get("generated")]
    if not pending:
        return None
    topic_entry = pending[0]
    topic_entry["generated"] = datetime.now(timezone.utc).isoformat()
    topics_file.write_text(json.dumps(topics, indent=2) + "\n")
    return topic_entry["topic"], topic_entry.get("notes", "")


def main():
    topic = os.environ.get("TOPIC", "").strip()
    notes = os.environ.get("NOTES", "").strip()

    if not topic:
        result = pick_scheduled_topic()
        if result is None:
            print("No pending topics in backlog. Nothing to generate.")
            return
        topic, notes = result
        print(f"Picked scheduled topic: {topic}")

    print(f"Generating article for: {topic}")
    article_content = generate_article(topic, notes)

    # Create Hugo page bundle
    slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")
    date_prefix = datetime.now(timezone.utc).strftime("%Y-%m")
    article_dir = HUGO_CONTENT / f"{date_prefix}-{slug}"
    article_dir.mkdir(parents=True, exist_ok=True)

    article_path = article_dir / "index.md"
    article_path.write_text(article_content)

    print(f"Article generated: {article_path}")
    print(f"Word count: ~{len(article_content.split())}")


if __name__ == "__main__":
    main()
