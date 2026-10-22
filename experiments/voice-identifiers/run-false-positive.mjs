#!/usr/bin/env node
/**
 * AC-112's criterion path, kept working and re-pointed.
 *
 * The recorded criterion runs this file with plain `node`, and it used to
 * measure the harness-local copy of the repair algorithm — so its zero said
 * nothing about the module the app calls. That copy is gone: the algorithm lives
 * only in `src/shared/identifierRepair.ts`. Plain `node` loads it (type
 * stripping, v22.18 and later), which is why this path did not have to change to
 * start measuring the shipped module.
 *
 * The runner is `run-shipped-false-positive.mjs`; this file exists so the
 * recorded criterion keeps resolving while measuring the shipped module.
 *
 *   node experiments/voice-identifiers/run-false-positive.mjs
 */

import './run-shipped-false-positive.mjs';
