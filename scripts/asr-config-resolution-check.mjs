#!/usr/bin/env node
/**
 * The criterion command for AC-134, which is registered against this file name.
 *
 * The reading itself lives in scripts/asr-health-provider-check.mjs — the file this task
 * declares, together with the falsification controls that prove it can go red. This entry point
 * exists because the goal record's criterion names it, and it does one thing: run that probe in
 * this process's place, forwarding the arguments it was given and exiting with its status, so
 * the criterion is judged by the same readings its controls are written against.
 *
 * Run with: node scripts/asr-config-resolution-check.mjs [--root <tree>] [--landing]
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(SCRIPT_DIR, 'asr-health-provider-check.mjs');

const result = spawnSync(process.execPath, [PROBE, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
