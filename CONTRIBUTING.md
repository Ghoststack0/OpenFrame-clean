# Contributing to OpenFrame

OpenFrame is a performance-focused fork of [Immich](https://github.com/immich-app/immich). Contributions to performance, upload reliability, mobile-to-desktop connections, accessibility, and user experience are welcome.

## Getting started

To get you started quickly we have detailed guides for the dev setup on the [upstream setup guide](https://docs.immich.app/developer/setup). If you prefer, you can also use [Devcontainers](https://docs.immich.app/developer/devcontainers).
There are also additional resources about Immich's architecture, database migrations, the use of OpenAPI, and more in the [upstream developer documentation](https://docs.immich.app/developer/architecture).

## General

Please try to keep pull requests as focused as possible. A PR should do exactly one thing and not bleed into other, unrelated areas. The smaller a PR, the fewer changes are likely needed, and the quicker it will likely be merged. For larger/more impactful PRs, please reach out to us first to discuss your plans. Open an issue in this fork to discuss the scope. Additionally, please fill out the entire template when opening a PR.

## Finding work

If you are looking for something to work on, there are discussions and issues with a `good-first-issue` label on them. These are always a good starting point. You can also propose work from the roadmap in the [README](README.md).

We usually do not assign issues to new contributors, since it happens often that a PR is never even opened. Comment on an issue before starting substantial work to avoid duplicate PRs.

### Opening new issues

If you find bugs or other problems while working on something, we appreciate that you open an issue, if there is no open issue covering the problem yet. To make it easier to debug and fix the issue, please read and fill out the whole issue template.

## AI-assisted contributions

AI-assisted and AI-generated pull requests are allowed, including implementations, performance improvements, bug fixes, tests, documentation, and issues labeled `good-first-issue`.

You are responsible for every submitted change. Review the code, explain the behavior and tradeoffs, disclose how AI was used in the PR template, and run the relevant checks. Never include credentials or private photo libraries in prompts, fixtures, or benchmark results.

For performance changes, include the baseline and candidate commits, machine and software versions, workload, commands, run count, and measured results. Compare both versions on the same Linux test bench with the same settings and disposable data. Report regressions and the limits of the measurement. A faster query alone does not prove faster uploads or a faster application.

We review contributions for correctness, security, maintainability, and evidence. AI use alone is not a reason to close a PR. Unreviewed bulk changes, fabricated results, and spam are not accepted.

## Proposing larger changes

Open an issue in this fork before a larger change so contributors can discuss the scope and avoid duplicate work. Upstream Immich contribution rules and feature freezes apply to upstream submissions, not to OpenFrame.

## Non-code contributions

If you want to contribute to OpenFrame but you don't feel comfortable programming in our tech stack, there are other ways you can help the team.

### Translations

Upstream Immich translations are maintained through [Weblate](https://hosted.weblate.org/projects/immich). These rely entirely on the community; if you speak a language that isn't fully translated yet, submitting translations there is greatly appreciated!

### Datasets

You can also contribute to upstream [Immich Datasets](https://datasets.immich.app) by submitting photos and videos taken from a variety of devices, including smartphones, DSLRs, and action cameras, as well as photos with unique features, such as panoramas, burst photos, and photo spheres. These datasets will be publicly available for anyone to use, do not submit private/sensitive photos.

### Community support

If you like helping others, answering Q&A discussions here on GitHub and helping contributors reproduce issues is also always appreciated.
