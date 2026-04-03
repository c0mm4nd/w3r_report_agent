# Web3 Research Report Agent

Autonomous daily research agent that:
1. Fetches trending Web3 topics from `ai.6551.io`
2. Selects the best topic for institutional-grade research
3. Deep-researches via browser automation (search → fetch → screenshot)
4. Writes a 2500+ word research report with Mermaid diagrams
5. Renders Mermaid diagrams as PNG images
6. Publishes the report to web3research

## Setup

```bash
cd report_agent

# 1. Install dependencies + Chromium
npm run setup

# 2. Create .env from template
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY and PRIVATE_KEY at minimum
```

## Run manually

```bash
node agent.mjs
# or
bash run.sh
```

## Schedule (cron)

Run daily at 08:00 UTC:

```cron
0 8 * * * /absolute/path/to/web3research/report_agent/run.sh >> /var/log/web3r-agent.log 2>&1
```

Add to crontab:
```bash
crontab -e
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | ✓ | — | Anthropic API key |
| `PRIVATE_KEY` | ✓ | — | Ethereum private key for SIWE auth |
| `BASE_URL` | | `https://web3resear.ch` | Web3Research instance URL |
| `CLAUDE_MODEL` | | `claude-sonnet-4-6` | Claude model to use |
| `BRAVE_API_KEY` | | — | Brave Search API key (improves search quality) |
| `WORK_DIR` | | `/tmp/web3r-agent` | Temp directory for screenshots and mermaid PNGs |
| `MAX_RESEARCH_ITER` | | `12` | Max browser tool iterations during research |
| `CHAIN_ID` | | `1` | Chain ID for SIWE message |

## Files

```
report_agent/
├── agent.mjs          Main orchestrator
├── browser.mjs        Playwright browser tools (search, fetch, screenshot)
├── mermaid.mjs        Mermaid diagram → PNG renderer
├── publish.mjs        Web3Research SIWE auth + report publish API client
├── run.sh             Cron-safe shell entry point
├── package.json
├── .env.example
└── prompts/
    ├── select-topic.md   Claude prompt: pick best research topic
    ├── research.md       Claude prompt: deep research agent loop
    └── write-report.md   Claude prompt: write institutional report
```

## Server requirements

- Node.js 18+
- ~500 MB disk (Chromium browser)
- ~1 GB RAM
- Outbound HTTP/HTTPS access

## Cost estimate

Per daily run (approximate):
- Claude API: ~$0.15–0.40 (research loop + report writing)
- Brave Search API: free tier (2000 req/month)
- web3research S3: negligible (~3–5 images/run)
