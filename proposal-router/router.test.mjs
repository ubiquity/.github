import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initProposalRouter } from "./main.js";
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

// Minimal DOM harness for end-to-end initProposalRouter regression tests.
function createFakeElement(tagName = "div") {
  const listeners = new Map();
  const attributes = new Map();
  return {
    tagName: tagName.toUpperCase(),
    value: "",
    textContent: "",
    href: "#",
    title: "",
    className: "",
    disabled: false,
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    setAttribute(name, val) {
      attributes.set(name, String(val));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(fn);
    },
    dispatchEvent(type) {
      for (const fn of listeners.get(type) ?? []) {
        fn({ type, target: this });
      }
    },
  };
}

function createFakeDom(initialTitle = "") {
  const elements = {
    "#proposal": createFakeElement("textarea"),
    "#title": createFakeElement("input"),
    "#repository": createFakeElement("select"),
    "#suggestions": createFakeElement("ol"),
    "#issue-link": createFakeElement("a"),
    "#copy-link": createFakeElement("button"),
  };
  elements["#title"].value = initialTitle;
  elements["#issue-link"].setAttribute("aria-disabled", "true");

  const document = {
    querySelector(selector) {
      return elements[selector] ?? null;
    },
    createElement(tag) {
      return createFakeElement(tag);
    },
  };

  return { document, elements };
}

function createCatalogFetch(catalogPromise) {
  return async () => {
    const data = await catalogPromise;
    return {
      ok: true,
      status: 200,
      async json() {
        return data;
      },
    };
  };
}

// Regression 1: Re-picking the currently auto-selected repository records an explicit choice.
{
  const { document, elements } = createFakeDom();
  await initProposalRouter({
    document,
    fetch: createCatalogFetch(Promise.resolve(repositories)),
    navigator: {},
  });

  const proposalInput = elements["#proposal"];
  const repositorySelect = elements["#repository"];
  const issueLink = elements["#issue-link"];

  proposalInput.value = "Fix the cash out interface on pay.ubq.fi because the claim screen is not centered.";
  proposalInput.dispatchEvent("input");

  assert.equal(repositorySelect.value, "");
  assert.equal(repositorySelect.children[0].value, "");
  assert.equal(repositorySelect.children[0].textContent, "Auto: ubiquity/pay.ubq.fi");
  assert.ok(repositorySelect.children.some((opt) => opt.value === "ubiquity/pay.ubq.fi"));
  assert.ok(issueLink.href.startsWith("https://github.com/ubiquity/pay.ubq.fi/issues/new?"));

  // User opens dropdown and picks the concrete option matching the auto-selected repo.
  repositorySelect.value = "ubiquity/pay.ubq.fi";
  repositorySelect.dispatchEvent("change");

  // Rewriting the proposal toward kernel topics must NOT override the explicit choice.
  proposalInput.value = "Route a new webhook command to the correct plugin in the kernel.";
  proposalInput.dispatchEvent("input");

  assert.equal(repositorySelect.value, "ubiquity/pay.ubq.fi");
  assert.ok(issueLink.href.startsWith("https://github.com/ubiquity/pay.ubq.fi/issues/new?"));

  // Switching back to the Auto option unpins cleanly.
  repositorySelect.value = "";
  repositorySelect.dispatchEvent("change");
  assert.equal(repositorySelect.value, "");
  assert.ok(issueLink.href.startsWith("https://github.com/ubiquity-os/ubiquity-os-kernel/issues/new?"));
}

// Regression 2: Custom title typed while catalog fetch is in flight survives initialization.
{
  const { document, elements } = createFakeDom();
  let resolveCatalog;
  const catalogPromise = new Promise((resolve) => {
    resolveCatalog = resolve;
  });

  const initPromise = initProposalRouter({
    document,
    fetch: createCatalogFetch(catalogPromise),
    navigator: {},
  });

  elements["#proposal"].value = "Fix the cash out interface on pay.ubq.fi";
  elements["#proposal"].dispatchEvent("input");
  elements["#title"].value = "My custom title during load";
  elements["#title"].dispatchEvent("input");

  resolveCatalog(repositories);
  await initPromise;

  assert.equal(elements["#title"].value, "My custom title during load");
  const params = new URL(elements["#issue-link"].href).searchParams;
  assert.equal(params.get("title"), "My custom title during load");
}

// Regression 3: Auto-title still works during delayed fetch when user only types proposal.
{
  const { document, elements } = createFakeDom();
  let resolveCatalog;
  const catalogPromise = new Promise((resolve) => {
    resolveCatalog = resolve;
  });

  const initPromise = initProposalRouter({
    document,
    fetch: createCatalogFetch(catalogPromise),
    navigator: {},
  });

  const proposalText = "Route a new webhook command to the correct plugin in the kernel.\nExtra context";
  elements["#proposal"].value = proposalText;
  elements["#proposal"].dispatchEvent("input");

  resolveCatalog(repositories);
  await initPromise;

  assert.equal(elements["#title"].value, inferTitle(proposalText));
}

// Regression 4: Pre-existing title present before initProposalRouter is not overwritten.
{
  const { document, elements } = createFakeDom("Existing manual title");
  await initProposalRouter({
    document,
    fetch: createCatalogFetch(Promise.resolve(repositories)),
    navigator: {},
  });

  elements["#proposal"].value = "Fix the cash out interface on pay.ubq.fi";
  elements["#proposal"].dispatchEvent("input");

  assert.equal(elements["#title"].value, "Existing manual title");
}

console.log("proposal-router tests passed");
