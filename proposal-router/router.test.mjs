import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CATALOG_UNAVAILABLE_NOTICE, initProposalRouter } from "./main.js";
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

// Regression: a failed catalog fetch displays recovery instructions that must
// remain visible across subsequent proposal edits until a reload succeeds.
function createMockElement(tag) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    tagName: tag.toUpperCase(),
    value: "",
    href: "#",
    disabled: false,
    className: "",
    textContent: "",
    title: "",
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    addEventListener(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    dispatch(event) {
      for (const handler of listeners.get(event) ?? []) {
        handler();
      }
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
  };
}

function createMockDocument() {
  const elements = {
    "#proposal": createMockElement("textarea"),
    "#title": createMockElement("input"),
    "#repository": createMockElement("select"),
    "#suggestions": createMockElement("ol"),
    "#issue-link": createMockElement("a"),
    "#copy-link": createMockElement("button"),
  };
  elements["#issue-link"].setAttribute("aria-disabled", "true");

  return {
    elements,
    querySelector(selector) {
      return elements[selector] ?? null;
    },
    createElement(tag) {
      return createMockElement(tag);
    },
  };
}

const failedDoc = createMockDocument();
await initProposalRouter({
  doc: failedDoc,
  fetchFn: async () => ({ ok: false, status: 503 }),
  nav: {},
});

assert.equal(failedDoc.elements["#repository"].disabled, true);
assert.equal(failedDoc.elements["#suggestions"].children.length, 1);
assert.equal(failedDoc.elements["#suggestions"].children[0].textContent, CATALOG_UNAVAILABLE_NOTICE);

// Simulate typing into the proposal field while the catalog is unavailable.
failedDoc.elements["#proposal"].value = "Fix the cash out interface on pay.ubq.fi";
failedDoc.elements["#proposal"].dispatch("input");

assert.equal(failedDoc.elements["#suggestions"].children.length, 1);
assert.equal(failedDoc.elements["#suggestions"].children[0].textContent, CATALOG_UNAVAILABLE_NOTICE);
assert.equal(failedDoc.elements["#repository"].disabled, true);
assert.equal(failedDoc.elements["#repository"].children.length, 0);
assert.equal(failedDoc.elements["#issue-link"].getAttribute("aria-disabled"), "true");
assert.equal(failedDoc.elements["#issue-link"].href, "#");

// Verify a successful reload restores suggestions and enables the issue link on edit.
const recoveredDoc = createMockDocument();
await initProposalRouter({
  doc: recoveredDoc,
  fetchFn: async () => ({ ok: true, json: async () => repositories }),
  nav: {},
});

assert.equal(recoveredDoc.elements["#repository"].disabled, false);
recoveredDoc.elements["#proposal"].value = "Fix the cash out interface on pay.ubq.fi";
recoveredDoc.elements["#proposal"].dispatch("input");

assert.ok(recoveredDoc.elements["#suggestions"].children.length > 0);
assert.notEqual(recoveredDoc.elements["#suggestions"].children[0].textContent, CATALOG_UNAVAILABLE_NOTICE);
assert.equal(recoveredDoc.elements["#issue-link"].getAttribute("aria-disabled"), "false");
assert.ok(recoveredDoc.elements["#issue-link"].href.startsWith("https://github.com/ubiquity/pay.ubq.fi/issues/new?"));

console.log("proposal-router tests passed");
