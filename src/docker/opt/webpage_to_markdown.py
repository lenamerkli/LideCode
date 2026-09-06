import argparse
import asyncio
import os
import sys
from crawl4ai import AsyncWebCrawler


def web_disabled() -> bool:
    """Return True when web access is disabled via the ALLOW_WEB environment variable."""
    return os.environ.get('ALLOW_WEB', 'true').strip().lower() in ('false', '0', 'no')


async def crawl(url: str, output: str | None = None) -> None:
    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url=url)

        markdown = result.markdown or ""

        if output:
            with open(output, "w", encoding="utf-8") as f:
                f.write(markdown)
        else:
            print(markdown)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Crawl a webpage and print its markdown output."
    )
    parser.add_argument(
        "url",
        help="The URL to crawl"
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Optional file to save the markdown output"
    )
    return parser.parse_args()


def main():
    if web_disabled():
        print("Error: web access is disabled for this session (ALLOW_WEB is false).", file=sys.stderr)
        sys.exit(1)
    args = parse_args()
    try:
        asyncio.run(crawl(args.url, args.output))
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
