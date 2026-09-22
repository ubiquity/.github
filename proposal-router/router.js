// Ranking and URL logic extracted from ubiquity/.github#134 by wognsdl2
// (head de3a5a618896d7354eea968c90c8de8ff5a6fdb3), with the heuristic score
// relabelled as a keyword-match score and explicit selection kept in the catalog.

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "with",
]);

function normalizeText(value) {
  return value.toLowerCase().replace(/[^a-z0-9./-]+/g, " ").trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function scoreRepository(repository, proposal) {
  const proposalTokens = tokenize(proposal);
  const haystack = normalizeText(`${repository.owner}/${repository.name} ${repository.description} ${repository.keywords.join(" ")}`);
  const matched = new Set();
  let score = 0;

  for (const token of proposalTokens) {
    if (haystack.includes(token)) {
      matched.add(token);
      score += repository.name.includes(token) ? 4 : 2;
    }
  }

  for (const phrase of repository.keywords) {
    if (normalizeText(proposal).includes(normalizeText(phrase))) {
      matched.add(phrase);
      score += phrase.includes(" ") ? 5 : 3;
    }
  }

  return {
    repository,
    score,
    // Relative keyword-overlap heuristic for ordering suggestions (0-100).
    // It is not a calibrated probability that this repository is the right target.
    matchScore: Math.min(100, Math.round((score / Math.max(8, proposalTokens.length * 2)) * 100)),
    matched: Array.from(matched).slice(0, 8),
  };
}

export function repositoryKey(repository) {
  return `${repository.owner}/${repository.name}`;
}

export function rankRepositories(repositories, proposal, limit = 5) {
  if (!proposal.trim()) {
    return repositories.slice(0, limit).map((repository) => ({ repository, score: 0, matchScore: 0, matched: [] }));
  }

  return repositories
    .map((repository) => scoreRepository(repository, proposal))
    .sort((left, right) => right.score - left.score || left.repository.name.localeCompare(right.repository.name))
    .slice(0, limit);
}

// Resolve the <select> contents from the committed catalog only. A preferred
// (manually chosen) repository stays selected and stays offered even when it
// drops out of the ranked suggestions; a key that is not in the catalog is
// rejected and never rendered as an option.
export function resolveRepositorySelection(repositories, suggestions, preferredKey = null) {
  const catalog = new Set(repositories.map((repository) => repositoryKey(repository)));
  const rankedKeys = [];

  for (const { repository } of suggestions) {
    const key = repositoryKey(repository);
    if (catalog.has(key) && !rankedKeys.includes(key)) {
      rankedKeys.push(key);
    }
  }

  const selected = preferredKey && catalog.has(preferredKey) ? preferredKey : (rankedKeys[0] ?? null);
  const options = selected && !rankedKeys.includes(selected) ? [...rankedKeys, selected] : rankedKeys;

  return { options, selected };
}

export function createIssueUrl(repository, title, body) {
  const params = new URLSearchParams({
    title: title.trim(),
    body: body.trim(),
  });
  return `https://github.com/${repository.owner}/${repository.name}/issues/new?${params.toString()}`;
}

export function inferTitle(proposal) {
  const firstLine = proposal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "";
  }

  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
}
