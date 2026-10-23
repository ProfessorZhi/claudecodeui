/**
 * A fetch-shaped double that cannot reach the network, and that leaves a trace when it is called.
 *
 * WHY A LOG AND NOT A RETURN VALUE. "The dry run sent nothing" is only a reading if a call is
 * observable, and a double that quietly returned a canned answer would make a call and a non-call
 * look identical from the caller's side. So every invocation appends one JSON line to the file named
 * by `$ASR_CLI_CALL_LOG`, and the criterion counts the lines: zero is the pass, and the count is what
 * makes it possible to say *how many* calls happened when it is not zero. When the variable is unset
 * the call still happened and simply is not recorded — a caller that wants the trace has to name
 * where it goes, so a stray environment cannot silently absorb it.
 *
 * The response it returns is intentionally uninteresting (`{"text":""}`, status 200). Nothing is
 * expected to look at it: the modes this double is injected into either do not call it (the pass) or
 * are being caught calling it (the failure), and giving it a plausible transcript would just be one
 * more thing a caller could accidentally depend on.
 *
 * Injected as `--fetch-impl ./scripts/__fixtures__/no-network-fetch.mjs`.
 */

import { appendFileSync } from 'node:fs';

/**
 * @param {string | { url?: unknown }} input
 * @param {{ method?: string } | undefined} [init]
 * @returns {Promise<Response>}
 */
export default async function noNetworkFetch(input, init) {
  const logPath = process.env.ASR_CLI_CALL_LOG;
  if (logPath) {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = String(init?.method ?? 'GET');
    appendFileSync(logPath, `${JSON.stringify({ method, url })}\n`);
  }

  return new Response(JSON.stringify({ text: '' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
