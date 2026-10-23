// Pilot corpus definition. Frozen before any recognition call.
// `spoken` is what the TTS is given; `gold` is what the dictation MEANT. They differ exactly where the
// experiment lives: "key" is the /kiː/ audio of quay, "kway" the /kweɪ/ one.
export const TERMS = [
  { id: 'quay',        gold: 'quay',        cls: 'A', say: { K: 'key', W: 'kway' } },
  { id: 'quay-fleet',  gold: 'quay-fleet',  cls: 'A', say: { K: 'key fleet', W: 'kway fleet' } },
  { id: 'cantus',      gold: 'cantus',      cls: 'A', say: { N: 'cantus' } },
  { id: 'archguard',   gold: 'archguard',   cls: 'A', say: { N: 'arch guard' } },
  { id: 'needs-human', gold: 'needs-human', cls: 'B', say: { N: 'needs human' } },
  { id: 'fan-in',      gold: 'fan-in',      cls: 'B', say: { N: 'fan in' } },
  { id: 'CloudCLI',    gold: 'CloudCLI',    cls: 'B', say: { N: 'cloud C L I' } },
  { id: 'SendMessage', gold: 'SendMessage', cls: 'B', say: { N: 'send message' } },
  { id: 'meta-cc',     gold: 'meta-cc',     cls: 'B', say: { N: 'meta C C' } },
  { id: 'worktree',    gold: 'worktree',    cls: 'B', say: { N: 'work tree' } },
  { id: 'MCP',         gold: 'MCP',         cls: 'C', say: { N: 'M C P' } },
  { id: 'GOAL-013',    gold: 'GOAL-013',    cls: 'D', say: { N: 'goal zero one three' } },
];
export const TEMPLATES = [
  { id: 'zh1', voice: 'zh-CN-XiaoxiaoNeural', text: (s) => `创建一个 ${s} 任务。` },
  { id: 'zh2', voice: 'zh-CN-YunxiNeural',    text: (s) => `检查 ${s} 的状态，然后告诉我结果。` },
  { id: 'en1', voice: 'en-US-AriaNeural',     text: (s) => `Create a ${s} task.` },
  { id: 'en2', voice: 'en-US-GuyNeural',      text: (s) => `Check the status of ${s} and tell me the result.` },
];
export const goldText = (tpl, t) => tpl.text(t.gold);
// Traps: the word really is the common homophone. Correct output keeps `key`.
export const TRAPS = [
  { id: 'tr1', voice: 'zh-CN-XiaoxiaoNeural', spoken: 'key file 已更新。', gold: 'key file 已更新。', keep: 'key' },
  { id: 'tr2', voice: 'zh-CN-YunxiNeural',    spoken: '把 API key 放到环境变量里。', gold: '把 API key 放到环境变量里。', keep: 'key' },
  { id: 'tr3', voice: 'zh-CN-XiaoxiaoNeural', spoken: '这个 ssh key 需要轮换。', gold: '这个 ssh key 需要轮换。', keep: 'key' },
  { id: 'tr4', voice: 'en-US-AriaNeural',     spoken: 'Press the enter key to send.', gold: 'Press the enter key to send.', keep: 'key' },
  { id: 'tr5', voice: 'en-US-GuyNeural',      spoken: 'Rotate the API key before the release.', gold: 'Rotate the API key before the release.', keep: 'key' },
  { id: 'tr6', voice: 'en-US-AriaNeural',     spoken: 'The key point is that it fails closed.', gold: 'The key point is that it fails closed.', keep: 'key' },
  { id: 'tr7', voice: 'zh-CN-YunxiNeural',    spoken: '这里的 key 是 session id。', gold: '这里的 key 是 session id。', keep: 'key' },
  { id: 'tr8', voice: 'zh-CN-XiaoxiaoNeural', spoken: '用 can not 这个词，而不是 cannot。', gold: '用 can not 这个词，而不是 cannot。', keep: null },
];
export const NEUTRAL = [
  { id: 'ne1', voice: 'zh-CN-XiaoxiaoNeural', spoken: '同意。按你的建议执行。', gold: '同意。按你的建议执行。' },
  { id: 'ne2', voice: 'zh-CN-YunxiNeural',    spoken: '检查进展，然后继续。', gold: '检查进展，然后继续。' },
  { id: 'ne3', voice: 'en-US-AriaNeural',     spoken: 'Please run the tests again and report the failures.', gold: 'Please run the tests again and report the failures.' },
  { id: 'ne4', voice: 'zh-CN-XiaoxiaoNeural', spoken: '把服务重启一下，再用浏览器验证。', gold: '把服务重启一下，再用浏览器验证。' },
  { id: 'ne5', voice: 'en-US-GuyNeural',      spoken: 'Open the settings page and show me the voice tab.', gold: 'Open the settings page and show me the voice tab.' },
  { id: 'ne6', voice: 'zh-CN-YunxiNeural',    spoken: '这个方案我倾向不补，否则任务大很多。', gold: '这个方案我倾向不补，否则任务大很多。' },
];
// multi-target (class mix), both pronunciations of quay-fleet
export const MULTI = [
  { id: 'mu1', voice: 'zh-CN-XiaoxiaoNeural', targets: ['quay-fleet', 'fan-in', 'needs-human'],
    spoken: (v) => `检查 ${v} 的 fan in，看看 needs human 是否阻塞。`, gold: '检查 quay-fleet 的 fan-in，看看 needs-human 是否阻塞。' },
  { id: 'mu2', voice: 'en-US-AriaNeural', targets: ['quay', 'SendMessage', 'MCP'],
    spoken: (v) => `Use send message to ask the ${v} session about the M C P gateway.`, gold: 'Use SendMessage to ask the quay session about the MCP gateway.' },
];
export const POOL = ['quay', 'quay-fleet', 'needs-human', 'fan-in', 'CloudCLI', 'SendMessage', 'meta-cc', 'archguard', 'cantus', 'MCP', 'worktree', 'GOAL-013'];
export const OTHER_PROJECT = ['terrain-pack', 'gemini-live-scribe', 'docker-tailscale', 'zrok', 'tmux', 'lan'];
// deterministic pick: the k-th other terms after `target` in POOL order, skipping anything that shares a stem
const stem = (s) => s.split('-')[0].toLowerCase();
export function others(targets, n) {
  const bad = new Set(targets.map(stem));
  return POOL.filter((t) => !bad.has(stem(t))).slice(0, n);
}
const wrap = (list) => `项目里的名字：${list.join('、')}。`;
export function context(cond, targets) {
  switch (cond) {
    case 'C0': return '';
    case 'C1': return wrap([...targets, ...others(targets, 6 - targets.length)]);
    case 'C5': return wrap(others(targets, 6));            // same length/shape, targets removed
    case 'C4': return wrap(OTHER_PROJECT);                 // wrong project
    case 'C2': return '上一轮助手回复（节选）：我先检查了 quay 的任务板：quay-fleet 里有两个任务停在 needs-human，原因是 fan-in 时 suite 超时；CloudCLI 这边的 SendMessage 已经可以寻址会话。接下来我会在 worktree 里复现，并把结果写进 GOAL-013。';
  }
}
