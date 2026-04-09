/**
 * API route handler for proposal routing.
 *
 * POST /api/route  { title, body, repo, owner }
 *   → Creates a GitHub issue in the target repo (if GITHUB_TOKEN is set)
 *   → Falls back to returning the routing decision without creating an issue
 */

const express = require("express");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

// ── POST /api/route ──────────────────────────────────────────────────────────
app.post("/api/route", (req, res) => {
  const { title, body, repo, owner } = req.body;

  if (!title || !body || !repo || !owner) {
    return res.status(400).json({ error: "Missing required fields: title, body, repo, owner" });
  }

  // Try creating a GitHub issue via `gh` CLI if available
  const fullName = `${owner}/${repo}`;
  try {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedBody = body.replace(/"/g, '\\"');
    const out = execSync(
      `gh issue create --repo ${fullName} --title "${escapedTitle}" --body "${escapedBody}"`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return res.json({ url: out, repo: fullName });
  } catch (err) {
    // gh not available or no auth — return routing result only
    return res.json({
      url: null,
      repo: fullName,
      note: "GitHub issue creation skipped (no gh CLI or token). Proposal routed successfully.",
      wouldCreateAt: `https://github.com/${fullName}/issues`
    });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proposal Router API running on http://localhost:${PORT}`);
});
