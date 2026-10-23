import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliEnvironment, CliOutput, CliPackageMetadata } from '@/shared/types.js';

import { createCliService } from '../cli.service.js';

function createHarness(
  packageMetadata: CliPackageMetadata = {
    version: '1.2.3',
    homepage: 'https://cloudcli.example',
    bugsUrl: 'https://cloudcli.example/issues',
  },
) {
  const logMessages: string[] = [];
  const errorMessages: string[] = [];
  const environment: CliEnvironment = {};
  const output: CliOutput = {
    log: (message = '') => logMessages.push(message),
    error: (message = '') => errorMessages.push(message),
  };
  let serverStarts = 0;
  let sandboxArguments: string[] = [];
  const service = createCliService({
    applicationRoot: '/application',
    defaultDatabasePath: '/home/user/.cloudcli/auth.db',
    homeDirectory: '/home/user',
    packageMetadata,
    environment,
    fileSystem: {
      pathExists: () => false,
      getFileStats: () => ({ size: 0, modifiedAt: new Date(0) }),
    },
    output,
    sandboxService: {
      execute: async (argumentsList) => {
        sandboxArguments = argumentsList;
        return 7;
      },
    },
    getLatestPackageVersion: async () => '1.2.3',
    updateGlobalPackage: () => undefined,
    startServer: async () => {
      serverStarts += 1;
    },
    startBrowserUseMcp: async () => undefined,
  });

  return {
    service,
    environment,
    logMessages,
    errorMessages,
    getServerStarts: () => serverStarts,
    getSandboxArguments: () => sandboxArguments,
  };
}

test('applies CLI options to the injected environment before starting the server', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run([
    '--port',
    '8080',
    '--database-path=/data/app.db',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(harness.environment.SERVER_PORT, '8080');
  assert.equal(harness.environment.DATABASE_PATH, '/data/app.db');
  assert.equal(harness.getServerStarts(), 1);
});

test('passes only sandbox arguments to the injected sandbox service', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['sandbox', 'ls']);

  assert.equal(exitCode, 7);
  assert.deepEqual(harness.getSandboxArguments(), ['ls']);
});

test('returns a failure code for an unknown command without exiting the process', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['unknown']);

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages[0], /Unknown command: unknown/);
});

test('help text falls back to the fork repository when package metadata is missing', async () => {
  // No homepage/bugsUrl: the help text must use its own fallbacks, not the upstream repository.
  const harness = createHarness({ version: '1.2.3' });

  const exitCode = await harness.service.run(['help']);

  assert.equal(exitCode, 0);
  const helpText = harness.logMessages.join('\n');
  assert.match(helpText, /yaleh\/claudecodeui/, 'the missing-metadata fallback must name the fork repository');
  assert.doesNotMatch(helpText, /siteboon/, 'the missing-metadata fallback must not name upstream siteboon');
});
