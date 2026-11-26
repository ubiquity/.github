// Regression coverage for ubiquity/.github#138: after a catalog fetch failure the still-installed
// proposal-edit listener wiped the recovery notice, leaving a disabled selector with no explanation.
//
// Run like the existing suite:  node proposal-router/main.test.mjs
//
// There is no DOM in Node and the page has no bundler or test dependency, so this stubs the handful of
// element methods main.js touches, imports the real module, and drives the real listener.

class StubElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.href = "";
    this.className = "";
    this.title = "";
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type });
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
}

const ids = ["proposal", "title", "repository", "suggestions", "issue-link", "copy-link"];
const elements = Object.fromEntries(ids.map((id) => [id, new StubElement()]));
globalThis.document = {
  querySelector: (selector) => elements[selector.replace(/^#/, "")] ?? null,
  createElement: (tag) => new StubElement(tag),
};
// Node 26 exposes navigator as a getter; the failure path never touches it, so leave it alone.
// The whole point of the scenario: the catalog request fails.
globalThis.fetch = async () => ({ ok: false, status: 500 });

await import("./main.js");

const suggestions = elements["suggestions"];
const repository = elements["repository"];
const noticeAfterLoad = suggestions.children[0]?.textContent ?? "";
if (!noticeAfterLoad.includes("Repository catalog unavailable")) {
  throw new Error(`expected a recovery notice after the failed fetch, got: ${noticeAfterLoad || "<none>"}`);
}
if (!repository.disabled) {
  throw new Error("expected the repository selector to be disabled while the catalog is unavailable");
}

// The regression: an edit must not render suggestions over the notice.
elements["proposal"].value = "Fix the cash out interface on pay.ubq.fi";
elements["proposal"].dispatch("input");

const noticeAfterEdit = suggestions.children[0]?.textContent ?? "";
if (!noticeAfterEdit.includes("Repository catalog unavailable")) {
  throw new Error(`the proposal edit cleared the recovery notice; suggestions now hold: ${noticeAfterEdit || "<none>"}`);
}
if (suggestions.children.length !== 1) {
  throw new Error(`expected the notice to be the only child, found ${suggestions.children.length}`);
}
if (!repository.disabled) {
  throw new Error("the proposal edit re-enabled the repository selector");
}

console.log("proposal-router main tests passed");
