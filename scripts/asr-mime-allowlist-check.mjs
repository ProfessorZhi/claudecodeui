#!/usr/bin/env node
/**
 * The criterion command for AC-133, which the goal record registers against this file name.
 *
 * The reading does not live here. It lives in scripts/asr-mime-size-gaps-check.mjs — the probe the
 * sibling task declared, which drives the tree's own service, router and client to measure the
 * container whitelist (base type matching, including the recorder's own `audio/webm;codecs=opus`)
 * and the two-layer size limit, with the falsification controls that prove each claim can go red.
 * This file exists only because the criterion names it, and it does one thing: run that probe in
 * this process's place, forwarding the arguments it was given and exiting with the probe's status,
 * so the criterion is judged by the same readings its controls are written against.
 *
 * Run with: node scripts/asr-mime-allowlist-check.mjs [--root <tree>] [--landing]
 */

import * as cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(SCRIPT_DIR, 'asr-mime-size-gaps-check.mjs');

const result = cp.spawnSync(process.execPath, [PROBE, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
