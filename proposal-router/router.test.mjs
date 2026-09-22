import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createIssueUrl, inferTitle, rankRepositories, repositoryKey, resolveRepositorySelection } from "./router.js";

const repositories = JSON.parse(await readFile(new URL("./repositories.json", import.meta.url), "utf8"));

const [paymentCandidate] = rankRepositories(repositories, "Fix the cash out interface on pay.ubq.fi because the claim screen is not centered.");
assert.equal(paymentCandidate.repository.name, "pay.ubq.fi");
assert.ok(Number.isInteger(paymentCandidate.matchScore));
assert.ok(paymentCandidate.matchScore >= 0 && paymentCandidate.matchScore <= 100);

const [kernelCandidate] = rankRepositories(repositories, "Route a new webhook command to the correct plugin in the kernel.");
assert.equal(kernelCandidate.repository.name, "ubiquity-os-kernel");

assert.equal(inferTitle("Fix proposal routing\nMore detail"), "Fix proposal routing");

const issueUrl = createIssueUrl(repositories[0], "Fix payout", "Body");
assert.equal(issueUrl, "https://github.com/ubiquity/pay.ubq.fi/issues/new?title=Fix+payout&body=Body");

// URLSearchParams keeps reserved characters inside the query values.
const encodedUrl = createIssueUrl(repositories[0], "Cash out & claims #3", "Steps:\n1. open pay.ubq.fi?tab=claims");
const encodedParams = new URL(encodedUrl).searchParams;
assert.equal(encodedParams.get("title"), "Cash out & claims #3");
assert.equal(encodedParams.get("body"), "Steps:\n1. open pay.ubq.fi?tab=claims");

// Regression: a repository chosen manually stays selected even when later
// proposal edits drop it out of the ranked suggestions.
const suggestions = rankRepositories(repositories, "Route a new webhook command to the correct plugin in the kernel.", 2);
const manualKey = "ubiquity/pay.ubq.fi";
assert.ok(
  !suggestions.some(({ repository }) => repositoryKey(repository) === manualKey),
  `${manualKey} is expected to fall outside this proposal's top suggestions`
);

const preserved = resolveRepositorySelection(repositories, suggestions, manualKey);
assert.equal(preserved.selected, manualKey);
assert.deepEqual(preserved.options, [...suggestions.map(({ repository }) => repositoryKey(repository)), manualKey]);

// A selection that is not part of the committed catalog is never selected or offered.
const rejected = resolveRepositorySelection(repositories, suggestions, "some-org/not-in-catalog");
assert.equal(rejected.selected, repositoryKey(suggestions[0].repository));
assert.ok(!rejected.options.includes("some-org/not-in-catalog"));
assert.ok(rejected.options.every((key) => repositories.some((repository) => repositoryKey(repository) === key)));

// Without a manual choice the top-ranked suggestion stays selected.
const automatic = resolveRepositorySelection(repositories, suggestions, null);
assert.equal(automatic.selected, repositoryKey(suggestions[0].repository));
assert.deepEqual(automatic.options, suggestions.map(({ repository }) => repositoryKey(repository)));

console.log("proposal-router tests passed");
