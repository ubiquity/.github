/**
 * Proposal Router — client-side logic
 *
 * Uses keyword frequency + cosine-similarity on a simple TF bag-of-words
 * model to score proposals against repository profiles.
 */

// ── Repository keyword profiles ──────────────────────────────────────────────
const REPO_PROFILES = {
  "ubiquity-dollar": {
    owner: "ubiquity",
    keywords: [
      "dollar", "ubc", "usd", "stablecoin", "token", "mint", "redeem",
      "collateral", "governance", "debt", "coupon", "treasury", "ubi",
      "ubiquity-dollar", "dollar-protocol", "ucr", "staking", "bond"
    ]
  },
  "arbitrage-bot": {
    owner: "ubiquity",
    keywords: [
      "arbitrage", "bot", "trading", "swap", "dex", "amm", "flash",
      "loan", "profit", "market", "price", "feed", "curve", "uniswap",
      "sushiswap", "balancer", "mev", "slippage", "liquidity"
    ]
  },
  "ubiquity-os": {
    owner: "ubiquity",
    keywords: [
      "ubiquity-os", "kernel", "plugin", "module", "event", "handler",
      "bot", "telegram", "discord", "webhook", "automation", "command",
      "middleware", "adapter", "runtime", "issue", "comment", "label"
    ]
  },
  "devpool-directory": {
    owner: "ubiquity",
    keywords: [
      "devpool", "bounty", "task", "directory", "freelance", "developer",
      "issue", "reward", "payout", "assignment", "price", "label",
      "github", "repository", "project", "bid", "hunter"
    ]
  },
  "business-development": {
    owner: "ubiquity",
    keywords: [
      "business", "partnership", "marketing", "strategy", "growth",
      "community", "social", "media", "brand", "content", "kpi",
      "roadmap", "pitch", "investor", "grants", "funding", "dao"
    ]
  }
};

// ── Utility: tokenise text ───────────────────────────────────────────────────
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);
}

// ── Build term-frequency vector for a token list against a keyword set ───────
function tfVector(tokens, keywords) {
  const counts = {};
  tokens.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  return keywords.map(kw => counts[kw] || 0);
}

// ── Cosine similarity ────────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Score a proposal against every repo ──────────────────────────────────────
function routeProposal(title, body) {
  const tokens = tokenize(title + " " + body);
  const results = [];

  for (const [repo, profile] of Object.entries(REPO_PROFILES)) {
    // profile vector is all 1s (each keyword equally important)
    const profileVec = profile.keywords.map(() => 1);
    const proposalVec = tfVector(tokens, profile.keywords);

    // cosine similarity (keyword overlap)
    const cosScore = cosineSim(proposalVec, proposalVec);

    // keyword hit count (bonus for raw matches)
    const hits = proposalVec.reduce((s, v) => s + v, 0);
    const hitBonus = Math.min(hits / profile.keywords.length, 1) * 0.3;

    // combined score clamped to 0-1
    const score = Math.min(cosScore * 0.7 + hitBonus, 1);

    results.push({ repo, owner: profile.owner, score, hits });
  }

  // normalise so top score = 1 if any match exists
  const maxScore = Math.max(...results.map(r => r.score));
  if (maxScore > 0) {
    results.forEach(r => { r.score = r.score / maxScore; });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── UI Rendering ─────────────────────────────────────────────────────────────
const form      = document.getElementById("proposal-form");
const resultsEl = document.getElementById("results");
const scoresEl  = document.getElementById("scores");
const recomEl   = document.getElementById("recommendation");
const confirmEl = document.getElementById("confirm-btn");
const statusEl  = document.getElementById("status");

let currentRecommendation = null;

function barColor(score) {
  if (score >= 0.7) return "#3fb950";
  if (score >= 0.4) return "#d29922";
  return "#8b949e";
}

function renderResults(routed) {
  scoresEl.innerHTML = "";
  routed.forEach(r => {
    const pct = Math.round(r.score * 100);
    const div = document.createElement("div");
    div.className = "repo-score";
    div.innerHTML = `
      <span class="repo-name">${r.repo}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${barColor(r.score)}"></div></div>
      <span class="score-val">${pct}%</span>`;
    scoresEl.appendChild(div);
  });

  const best = routed[0];
  currentRecommendation = best;
  recomEl.innerHTML = `Recommended: <strong>${best.repo}</strong> (${Math.round(best.score * 100)}% confidence, ${best.hits} keyword hits)`;
  resultsEl.classList.remove("hidden");
}

form.addEventListener("submit", e => {
  e.preventDefault();
  const title = document.getElementById("title").value.trim();
  const body  = document.getElementById("body").value.trim();
  if (!title || !body) return;
  const routed = routeProposal(title, body);
  renderResults(routed);
});

confirmEl.addEventListener("click", async () => {
  if (!currentRecommendation) return;
  const title = document.getElementById("title").value.trim();
  const body  = document.getElementById("body").value.trim();
  const { repo, owner } = currentRecommendation;

  statusEl.className = "hidden";
  confirmEl.disabled = true;
  confirmEl.textContent = "Creating issue…";

  try {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, repo, owner })
    });
    const data = await res.json();
    if (data.url) {
      statusEl.className = "success";
      statusEl.textContent = `✅ Issue created: ${data.url}`;
    } else {
      throw new Error(data.error || "Unknown error");
    }
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = `❌ ${err.message}`;
  } finally {
    statusEl.classList.remove("hidden");
    confirmEl.disabled = false;
    confirmEl.textContent = "Create Issue in Recommended Repo";
  }
});
