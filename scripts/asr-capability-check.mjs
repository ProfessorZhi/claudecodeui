#!/usr/bin/env node
/**
 * The criterion command for AC-132, which the goal record registers against this file name.
 *
 * The reading does not live here. It lives in scripts/asr-second-adapter-check.mjs — the probe the
 * sibling task declared, with the three falsification controls that prove each claim can go red
 * (over-budget costs zero upstream calls; the budget is the WHOLE request; an unacknowledged hint
 * is not on the wire). This file exists only because the criterion names it, and it does one
 * thing: run that probe in this process's place, forwarding the arguments it was given and exiting
 * with the probe's status, so the criterion is judged by the same readings its controls are
 * written against.
 *
 * Run with: node scripts/asr-capability-check.mjs [--root <tree>] [--landing]
 */

import * as cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(SCRIPT_DIR, 'asr-second-adapter-check.mjs');

const result = cp.spawnSync(process.execPath, [PROBE, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
