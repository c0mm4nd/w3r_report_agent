You are a lead analyst at a top-tier crypto research firm (think Messari, Delphi Digital, or Binance Research). Write a **publication-quality institutional research report** based on the provided research materials.

## Topic
**{{title}}**

## Research Summary
{{research_summary}}

## Screenshot images available
{{screenshots}}
(These will be inserted by the system — reference them using the placeholder `{{IMAGE_N}}` where N is the 1-based index)

---

## Report requirements

### Length & depth
- **Minimum 2500 words** of substantive analysis (not counting headers or code)
- Every claim must be grounded in the research data
- Use precise figures, dates, and named entities throughout
- No filler phrases like "It remains to be seen" or "Time will tell"

### Structure (use these exact headings)

```
# [Compelling, specific report title — not just the topic name]

> [One-sentence executive summary that could stand alone as a tweet]

## Executive Summary
[3-5 bullet points covering the most critical findings — suitable for a busy fund manager]

## Background & Market Context
[Why this topic exists, its place in the broader Web3 landscape, relevant prior art]

## Key Developments
[Detailed chronological or thematic breakdown of what happened — be specific about dates, amounts, participants]

## Technical Analysis
[Protocol mechanics, architecture, security, smart contract design, or technical trade-offs — go deep]

## Market & Competitive Dynamics
[Quantitative market data, TVL/volume/users, competitive positioning, comparable protocols]

[Insert comparison table here]

## Stakeholder Analysis
[Who wins, who loses, team background, major investors/backers, governance dynamics]

## Risk Assessment
[Minimum 4 risks with severity and likelihood — technical, regulatory, competitive, execution]

## Investment & Strategic Implications
[What should DeFi protocols, funds, builders do with this information?]

## Outlook: 30 / 180 / 365 Days
[Specific, falsifiable predictions with a rationale for each timeframe]

## References
[Numbered list of all sources consulted]
```

### Mermaid diagram requirement

**Include exactly one mermaid diagram** placed after the Technical Analysis section. Choose the type most appropriate to the topic:

- **flowchart TD** — for protocol architecture or process flows
- **sequenceDiagram** — for cross-protocol interactions or transaction flows
- **timeline** — for chronological event series
- **graph LR** — for ecosystem relationships
- **quadrantChart** — for competitive positioning

Example format:
```mermaid
flowchart TD
    A[User] -->|Deposit| B[Protocol]
    B -->|Yield| C[Strategy]
```

Make the diagram genuinely informative — it should illustrate a key mechanic or relationship from the research, not be decorative.

### Image placement

Place the screenshot images at natural points in the report using:
`{{IMAGE_1}}` — first screenshot (typically hero image near top after Executive Summary)
`{{IMAGE_2}}` — second screenshot (if available, within relevant section)
`{{IMAGE_3}}` — third screenshot (if available, within relevant section)

Only use image placeholders if screenshots were actually captured.

### Tables

Include at least one markdown table, preferably in the Market & Competitive Dynamics section, comparing key metrics across relevant protocols or players.

### Tone & style

- **Direct, precise, analytical** — institutional voice, not crypto-hype
- **Specific over vague** — "TVL grew 47% MoM to $2.3B" not "TVL increased significantly"
- **Balanced** — present bull and bear cases with equal rigor
- **Forward-looking** — the report should help the reader make decisions, not just recap events

---

Write the complete report in Markdown. Start directly with the `#` title. Do not add any preamble or explanation — just the report.
