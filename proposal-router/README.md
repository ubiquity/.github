# Proposal Router

Auto-routing proposal system for the Ubiquity ecosystem. Submit a proposal title and body — the router scores it against repository keyword profiles and recommends the best target repo.

## Features

- **Single-page UI** — form-based proposal submission
- **Keyword/embedding similarity** — TF bag-of-words + cosine similarity scoring
- **Multi-repo support** — ubiquity-dollar, arbitrage-bot, ubiquity-os, devpool-directory, business-development
- **Confidence scores** — visual bar chart with percentage scores per repo
- **GitHub issue creation** — one-click issue creation via `gh` CLI (when available)

## Quick Start

```bash
# Option 1: Open the static UI directly
open proposal-router/index.html

# Option 2: Run the API server (enables issue creation)
cd proposal-router
npm install          # express only
npm start            # → http://localhost:3000
```

## How Routing Works

1. Proposal title + body are tokenised into lowercase words
2. A term-frequency vector is built against each repo's keyword profile
3. Cosine similarity is computed between the proposal vector and the profile vector
4. A keyword-hit bonus is added for raw match count
5. Scores are normalised so the best match = 100%

## API

### `POST /api/route`

```json
{
  "title": "Add UBC/USDC liquidity pool",
  "body": "We should create a new liquidity pool…",
  "repo": "ubiquity-dollar",
  "owner": "ubiquity"
}
```

Response:

```json
{
  "url": "https://github.com/ubiquity/ubiquity-dollar/issues/42",
  "repo": "ubiquity/ubiquity-dollar"
}
```

If the `gh` CLI is unavailable, the API returns the routing decision without creating an issue.

## Supported Repositories

| Repository | Focus Area |
|---|---|
| ubiquity-dollar | Stablecoin protocol, minting, collateral, governance |
| arbitrage-bot | Trading bot, DEX arbitrage, MEV, flash loans |
| ubiquity-os | Plugin system, event handlers, automation |
| devpool-directory | Bounty management, task assignment, payouts |
| business-development | Partnerships, marketing, strategy, community |

## License

MIT
