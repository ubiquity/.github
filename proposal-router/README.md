# Proposal Router

A dependency-free, static MVP that helps route a new Ubiquity proposal to a repository: type a
proposal, get live ranked suggestions, choose the target repository, and review a prefilled GitHub
issue URL before opening it.

This directory is an extraction of the implementation from
[ubiquity/.github#134](https://github.com/ubiquity/.github/pull/134) by
[@wognsdl2](https://github.com/wognsdl2) (head commit
`de3a5a618896d7354eea968c90c8de8ff5a6fdb3`), written for bounty issue
[ubiquity/.github#123](https://github.com/ubiquity/.github/issues/123). The ranking and issue-URL
logic is the donor's; the corrections made on extraction are described below.

## What it does

- A GitHub-style proposal composer with a live title derived from the first line.
- Live repository suggestions while the user types, ranked by a local keyword match over
  `repositories.json`.
- A target repository dropdown. Choosing a repository (in the dropdown or by clicking a suggestion
  card) is an explicit choice: later proposal edits keep that repository selected and keep its
  option available, even when it drops out of the top suggestions. Only the user changes the
  target.
- A generated GitHub issue URL with the proposal title and body prefilled through
  `URLSearchParams`. No raw proposal text is inserted into the page as HTML.
- A best-effort **Copy Link** button. If the browser rejects the clipboard write, the button reports
  `Copy failed` instead of claiming success.

Repository options are resolved against the committed `repositories.json` catalog; a value that is
not in that catalog is never selected or offered.

## What it is not

This is the extracted keyword-based static MVP, **not** the design that issue #123 prefers. In
particular it does not implement, and does not pretend to implement:

- the issue/comment matchmaking database the maintainer preferred as the routing signal;
- vector embeddings or any learned similarity;
- a Telegram or other natural-language interface;
- time, priority, or price estimates, or DevPool distribution;
- automatic issue posting or any server-side component. There is no token, no Express server, no
  shell execution, and no API that creates issues;
- a hosted production service. Whether and where to host this is still undecided in issue #123.

The `Open GitHub Issue` link only prepares GitHub's new-issue page for the selected repository with
the title and body prefilled. A human still has to review and submit it; nothing is posted by this
UI.

The number shown next to each suggestion is a **relative keyword-match score (0-100)** used only to
order the list. It is a heuristic over curated metadata, not a calibrated probability that the
repository is the correct target.

## Local preview

`main.js` fetches `repositories.json`, so the page must be served over HTTP. Opening `index.html`
directly from the filesystem will not load the catalog.

From the repository root, serve the directory with any static file server and open
`/proposal-router/`. For example:

```bash
deno run --allow-read --allow-net jsr:@std/http/file-server
```

Then visit <http://127.0.0.1:8000/proposal-router/>.

## Verification

The ranking, URL, and selection logic can be checked without installing dependencies:

```bash
node proposal-router/router.test.mjs
```

Deno's Node compatibility runs the same script:

```bash
deno run --allow-read proposal-router/router.test.mjs
```

Both should print `proposal-router tests passed` and exit 0.
