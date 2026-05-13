import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createIssueUrl, inferTitle, rankRepositories } from "./router.js";

const repositories = JSON.parse(await readFile(new URL("./repositories.json", import.meta.url), "utf8"));

const [paymentCandidate] = rankRepositories(repositories, "Fix the cash out interface on pay.ubq.fi because the claim screen is not centered.");
assert.equal(paymentCandidate.repository.name, "pay.ubq.fi");

const [kernelCandidate] = rankRepositories(repositories, "Route a new webhook command to the correct plugin in the kernel.");
assert.equal(kernelCandidate.repository.name, "ubiquity-os-kernel");

assert.equal(inferTitle("Fix proposal routing\nMore detail"), "Fix proposal routing");

const issueUrl = createIssueUrl(repositories[0], "Fix payout", "Body");
assert.equal(issueUrl, "https://github.com/ubiquity/pay.ubq.fi/issues/new?title=Fix+payout&body=Body");

console.log("proposal-router tests passed");
