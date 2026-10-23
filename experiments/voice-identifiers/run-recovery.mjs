#!/usr/bin/env node
/**
 * AC-113's original criterion path, kept working and re-pointed.
 *
 * This file used to measure the harness-local copy of the repair algorithm.
 * There is no copy any more — the algorithm lives only in
 * `src/shared/identifierRepair.ts` — and the measurement now runs there, because
 * the reading is only worth taking if it describes the app the transcript will
 * actually pass through.
 *
 * The runner is `run-shipped-recovery.mjs`; this file exists so the recorded
 * criterion keeps resolving while measuring the shipped module.
 *
 *   npx tsx experiments/voice-identifiers/run-recovery.mjs
 */

import './run-shipped-recovery.mjs';
