#!/usr/bin/env bash
#
# Static-check registry for this repository, in the shape quay's
# plugin/scripts/select-static-checks-for-touches.ts parses.
#
# WHY THIS FILE EXISTS
# --------------------
# quay's fan-in resolves its static-check registry at a HARDCODED repo-relative
# path — `plugin/scripts/runner-static-gate.ts` (TEST_SH_REL in
# select-static-checks-for-touches.ts). There is no flag, env var or
# .quay/config.yml key to point it elsewhere. quay's own repo satisfies that path
# because the plugin lives in a `plugin/` subdirectory there; an INSTALLED quay
# flattens `plugin/` into the plugin root, so the path never resolves from the
# plugin side either. In a target project the file therefore has to be supplied
# by the project, or `--classify-delta` exits 2 and every fan-in fails closed.
#
# WHAT BREAKS WITHOUT IT
# ----------------------
# fan-in's `flip-done` step commits `tasks/<id>.md` AFTER the suite has run, so
# the suite certificate must classify the `suite_head..tip` delta as inert.
# `--classify-delta` exiting 2 makes that NOT-EVALUATED, the certificate gate
# fails closed, and ff is refused — burning a full suite run per attempt until
# flip-done happens to be a no-op. See .quay/fan-in-step-trace.jsonl.
#
# WHAT THE REGISTRY MEANS HERE
# ----------------------------
# The registry's only job in this repo is `--classify-delta`: a path is "doc"
# when no `change`/`full`-tier checker's `@static-object` glob matches it AND it
# sits on a doc surface (tasks/ goals/ docs/ adr/ .quay/ measurements/
# milestones/). Everything else is code. The entries below are quay's own
# self-hosting checkers, none of which apply to this project, so the registry is
# deliberately EMPTY — which is the fail-closed direction: with no globs to match,
# only the doc surfaces are inert and all source paths classify as code.
#
# Add a `# @static-tier change` + `# @static-object <glob>…` annotated
# `run_checker` line below if this project ever grows a checker that should widen
# the code surface.
#
# NOT on any lint/typecheck/test path: `tsc` uses tsconfig.json's
# include ["src","shared","vite.config.js"], `oxlint` is invoked as `oxlint src/
# server/`, vitest includes `src/**`, and scripts/test.sh scans `server/` only.
run_static_checks() {
  :
}
