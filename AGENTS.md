# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Running tests

Never run an unbounded multi-file `--test` fan-out, or the full suite, from inside a session: the
session's cgroup caps at 8G and the kernel OOM-kills it (exit 137). Scale the runner to what you
are about to run — one file directly, a glob under `with-memory-cap.sh` with a concurrency clamp,
the full suite only in quay's fan-in. The rules and the table are in
`docs/operations/process-isolation-and-memory-caps.md` → "Running tests from a Claude session".
