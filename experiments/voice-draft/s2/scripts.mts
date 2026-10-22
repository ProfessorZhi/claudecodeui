// S2 脚本与标准答案。见 ../PREREG.md。
//
// 每条脚本 = 一串发言单元（TTS 的输入，也是切段的边界）+ 手写的标准答案：
//   · items     草稿应当满足的要求，每条带一个谓词 `ok(t)`；
//   · forbidden 不得作为有效要求出现的内容（被撤回的、被搁置的、被「删掉刚才那段」删除的、被数字覆盖的旧值）；
//   · goodDraft / badDraft 只用于判据自检（selfcheck.mts）：前者逐条满足 items 且不触发 forbidden，
//     后者触发全部 forbidden 且不满足任何 item。谓词在自检通过之前不得用于取数。
//
// 谓词吃的是 normalize() 之后的文本：去空白、去反引号与星号、把常见中文数字写成阿拉伯数字。

export type Kind = 'add' | 'retract' | 'number' | 'command' | 'nearmiss' | 'negation' | 'deictic' | 'sidenote' | 'identifier';
export type Item = { id: string; kind: Kind; early?: boolean; ident?: boolean; ok: (t: string) => boolean };
export type Forbidden = { id: string; kind: Kind; hit: (t: string) => boolean };
export type Unit = { n: number; text: string; role: 'add' | 'retract' | 'sidenote' | 'command' | 'nearmiss' | 'refine' };
export type Script = { id: string; topic: string; units: Unit[]; items: Item[]; forbidden: Forbidden[]; goodDraft: string; badDraft: string };

const NUM: [RegExp, string][] = [
  [/三零零一|三千零一/g, '3001'], [/三零零二|三千零二/g, '3002'], [/五百毫秒/g, '500毫秒'], [/一千毫秒/g, '1000毫秒'],
  [/二十/g, '20'], [/三十/g, '30'], [/十五/g, '15'], [/六十分钟/g, '60分钟'], [/两分钟|二分钟/g, '2分钟'], [/一小时/g, '1小时'], [/一秒/g, '1秒'],
  [/第二条/g, '第2条'], [/第三条/g, '第3条'], [/三条/g, '3条'], [/四条/g, '4条'],
];
export function normalize(s: string): string {
  // v2（取数后修复的缺陷 A）：换行先变成句号再去空白，否则条目之间的否定语境会串到下一条，既少算泄漏也误伤召回。
  let t = s.replace(/\n+/g, '。').replace(/[`*\s]/g, '');
  for (const [re, to] of NUM) t = t.replace(re, to);
  return t;
}

/** 否定、搁置、撤回的语境词：出现在匹配之前（同一句内）则该匹配不算「有效要求」。 */
const NEG = /(不要|不能|不得|不可|别|不做|不用|先不|暂不|不再|避免|而非|并非|不是|排除|推迟|以后再|之后再|先别|不使用|不采用|不改|不动|不碰|不需要|无需|放弃|取消|撤回|待定|待议|未定|没想好|暂缓|搁置|备忘|后续再|暂时不|不先|不必|禁止)/;
const AHEAD = /^[^。；\n]{0,3}(改为|改成|调整为|调为|→|换成|变为|更正为|改到)/;
/** 匹配之后同一句内紧跟搁置语：「移动端布局以后再调」。 */
const DEFER_AFTER = /^[^。；\n]{0,12}(以后再|之后再|后续再|暂不|先不|不做|待定|再说|先别)/;
/** re 在 t 里有一处匹配，且它前面（同一句、16 字内）没有否定语境、后面没有紧跟「改为」。 */
export function active(t: string, re: RegExp, win = 16): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of t.matchAll(g)) {
    const i = m.index ?? 0;
    const sent = Math.max(t.lastIndexOf('。', i - 1), t.lastIndexOf('；', i - 1), t.lastIndexOf('\n', i - 1));
    const prefix = t.slice(Math.max(sent + 1, i - win), i);
    if (NEG.test(prefix)) continue;
    const rest = t.slice(i + m[0].length, i + m[0].length + 24);
    if (AHEAD.test(rest.slice(0, 8))) continue;
    if (DEFER_AFTER.test(rest)) continue;
    return true;
  }
  return false;
}
const near = (t: string, a: RegExp, b: RegExp, win = 30): boolean => {
  const ga = new RegExp(a.source, a.flags.includes('g') ? a.flags : a.flags + 'g');
  for (const m of t.matchAll(ga)) {
    const i = m.index ?? 0;
    if (b.test(t.slice(Math.max(0, i - win), i + m[0].length + win))) return true;
  }
  return false;
};
const S = '[^。；\\n]'; // 同一句内

// ───────────────────────────────── L1 语音草稿面板
const L1: Script = {
  id: 'L1', topic: '在 composer 里加语音草稿入口与面板',
  units: [
    { n: 1, role: 'add', text: '我想在 composer 里加一个语音草稿的入口，放在 VoiceInputButton 旁边，点一下进入一个草稿面板。' },
    { n: 2, role: 'add', text: '面板里每一段语音转成一张卡片，每张卡片有删除按钮，这样手机上不用碰光标就能删。' },
    { n: 3, role: 'add', text: '转写直接复用现有的 transcribeVoice，不要新增识别的服务端接口。' },
    { n: 4, role: 'retract', text: '分段我本来想在服务端用 WebSocket 推流，嗯不对，太重了，还是在浏览器里按停顿切段，每段单独上传。' },
    { n: 5, role: 'sidenote', text: '分支和停车场那个想法先记着，这一版不做。' },
    { n: 6, role: 'add', text: '结束的时候直接发送给 Claude Code。' },
    { n: 7, role: 'command', text: '删掉刚才那段。' },
    { n: 8, role: 'add', text: '结束的时候把所有有效的段拼成一份草稿，填回 composer 的输入框，由我确认以后再用现有的发送按钮发出去。' },
    { n: 9, role: 'add', text: '撤销也要有，撤销是把最近删掉的那张卡片恢复回来。' },
    { n: 10, role: 'add', text: '单段上传的时长上限先设成三十秒，超过的话在最近的停顿处强制切开。' },
    { n: 11, role: 'retract', text: '嗯，三十秒有点长，改成二十秒吧。' },
    { n: 12, role: 'add', text: '手机上的入口不要放进 ComposerMobileMoreMenu，直接放在输入框旁边。' },
    { n: 13, role: 'add', text: '还有，刚才说的那个卡片，要显示这一段的时长。' },
  ],
  items: [
    { id: 'I1', kind: 'identifier', early: true, ident: true, ok: (t) => /VoiceInputButton/i.test(t) && near(t, /VoiceInputButton/i, /旁|附近|相邻|紧邻|并列/, 30) && /草稿/.test(t) },
    { id: 'I2', kind: 'add', early: true, ok: (t) => near(t, /卡片/, /删除|删掉/, 30) },
    { id: 'I3', kind: 'identifier', early: true, ident: true, ok: (t) => active(t, /transcribeVoice/i) && near(t, /transcribeVoice/i, /复用|沿用|使用|调用|直接/, 30) },
    { id: 'I4', kind: 'negation', early: true, ok: (t) => new RegExp(`(不要|不得|无需|不需要|不新增|不增加|避免|禁止|不新建)${S}{0,20}(接口|端点|endpoint)`, 'i').test(t) },
    { id: 'I5', kind: 'retract', ok: (t) => new RegExp(`(浏览器|前端|客户端)${S}{0,20}(停顿|静音)`).test(t) && new RegExp(`(单独|逐段|每段)${S}{0,10}上传|上传${S}{0,10}(每段|逐段)`).test(t) },
    { id: 'I6', kind: 'add', ok: (t) => near(t, /填|写入|回填|放入/, /输入框|composer/i, 20) },
    { id: 'I7', kind: 'add', ok: (t) => new RegExp(`(确认|审阅|检查)${S}{0,20}(发送|发出)`).test(t) && new RegExp(`(现有|已有|原有|现在的)${S}{0,10}发送`).test(t) },
    { id: 'I8', kind: 'add', ok: (t) => near(t, /撤销/, /恢复|还原|找回/, 30) },
    { id: 'I9', kind: 'number', ok: (t) => near(t, /20秒/, /上限|最长|不超过|超过/, 20) && /强制|切开|切分|切断/.test(t) },
    { id: 'I10', kind: 'negation', ok: (t) => new RegExp(`(不要|别|不放|不得|不能)${S}{0,15}ComposerMobileMoreMenu`, 'i').test(t) && /输入框(旁|附近)/.test(t) },
    { id: 'I11', kind: 'deictic', ok: (t) => near(t, /卡片/, /时长/, 25) },
  ],
  forbidden: [
    { id: 'F1', kind: 'retract', hit: (t) => active(t, /WebSocket/i) },
    { id: 'F2', kind: 'sidenote', hit: (t) => active(t, /分支|停车场|parking/i) },
    { id: 'F3', kind: 'command', hit: (t) => active(t, /(直接|自动)(发送|发给|提交)/) },
    { id: 'F4', kind: 'number', hit: (t) => active(t, /30秒/) },
  ],
  goodDraft: `在 composer 里新增语音草稿入口，放在 VoiceInputButton 旁边，点击进入草稿面板。
面板中每段语音是一张卡片，卡片带删除按钮。
转写复用现有的 transcribeVoice，不要新增识别的服务端接口。
在浏览器里按停顿切段，每段单独上传。
结束时把有效的段拼成草稿，填回 composer 输入框，用户确认后再用现有的发送按钮发出。
提供撤销：恢复最近删除的卡片。
单段时长上限 20 秒，超过则在最近的停顿处强制切开。
手机上的入口不要放进 ComposerMobileMoreMenu，直接放在输入框旁边。
卡片上显示该段的时长。
暂不做：分支功能。`,
  badDraft: `使用服务端 WebSocket 推流做分段。
实现分支和停车场功能。
结束时自动发送给 Claude Code。
单段上传上限 30 秒。`,
};

// ───────────────────────────────── L2 会话自动改名
const L2: Script = {
  id: 'L2', topic: '会话列表自动生成短名字',
  units: [
    { n: 1, role: 'add', text: '左侧会话列表里的名字现在都取第一次对话的内容，太长了，我想自动改成短名字。' },
    { n: 2, role: 'add', text: '短名字用会话最后一段内容生成，复用现在已有的标题生成那条路径，不要新起一个调用模型的通道。' },
    { n: 3, role: 'retract', text: '触发时机先定成每一轮回复结束都重新生成一次。嗯不对，这样太费，改成会话空闲超过两分钟再生成。' },
    { n: 4, role: 'add', text: '用户手动改过的名字不能被覆盖。' },
    { n: 5, role: 'sidenote', text: '标题要不要支持英文，这个我还没想好，先别写进去。' },
    { n: 6, role: 'add', text: '生成失败的时候保留旧名字，不要弹任何报错。' },
    { n: 7, role: 'add', text: '短名字最多二十个字。' },
    { n: 8, role: 'command', text: '删掉刚才那段。' },
    { n: 9, role: 'add', text: '短名字最多十五个字。' },
    { n: 10, role: 'nearmiss', text: '对了，现在有一段删掉旧标题的逻辑，要不要一起改？先不用，保持原样。' },
    { n: 11, role: 'add', text: '最后，这个改动只做在左侧会话列表那里，别动聊天页面顶部的标题。' },
  ],
  items: [
    { id: 'I1', kind: 'add', early: true, ok: (t) => near(t, /会话列表|左侧列表|侧边栏/, /短名字|短标题|缩短|自动(改名|命名|重命名)/, 40) },
    { id: 'I2', kind: 'add', early: true, ok: (t) => near(t, /最后一段|最后一条|末段|最后一轮/, /生成/, 30) },
    { id: 'I3', kind: 'negation', early: true, ok: (t) => near(t, /复用|沿用|已有|现有/, /标题生成/, 20) && new RegExp(`(不要|不得|不新增|不新建|避免|无需)${S}{0,15}(通道|路径|调用)`).test(t) },
    { id: 'I4', kind: 'retract', early: true, ok: (t) => new RegExp(`(空闲|闲置)${S}{0,12}2分钟|2分钟${S}{0,8}(空闲|闲置)`).test(t) },
    { id: 'I5', kind: 'negation', ok: (t) => new RegExp(`(手动|用户自己)${S}{0,15}(不能|不得|不要|不可|不会|不被)${S}{0,6}(覆盖|改动|修改|替换)|(不能|不得|不要)覆盖${S}{0,10}手动`).test(t) },
    { id: 'I6', kind: 'negation', ok: (t) => near(t, /失败/, /保留(旧|原)(名字|名称|标题)/, 25) && new RegExp(`不(要)?(弹|显示|提示|报)${S}{0,6}(报错|错误)`).test(t) },
    { id: 'I7', kind: 'number', ok: (t) => near(t, /15(个)?(字|汉字)/, /最多|不超过|上限/, 12) },
    { id: 'I8', kind: 'nearmiss', ok: (t) => near(t, /旧标题/, /保持原样|不改|不用|不动|保留|先不/, 30) },
    { id: 'I9', kind: 'deictic', ok: (t) => new RegExp(`(只|仅)${S}{0,8}(会话列表|左侧)`).test(t) && new RegExp(`(不(要)?(动|改|修改|改动|碰)|别(动|改))${S}{0,12}(顶部|聊天页面)`).test(t) },
  ],
  forbidden: [
    { id: 'F1', kind: 'retract', hit: (t) => active(t, /每一轮[^。；\n]{0,12}(重新)?生成/) },
    { id: 'F2', kind: 'sidenote', hit: (t) => active(t, /英文/) },
    { id: 'F3', kind: 'command', hit: (t) => active(t, /20(个)?(字|汉字)/) },
  ],
  goodDraft: `左侧会话列表的名字目前取第一次对话内容，过长；改为自动生成短名字。
短名字用会话最后一段内容生成，复用已有的标题生成路径，不要新建调用模型的通道。
触发时机：会话空闲超过 2 分钟后生成。
用户手动改过的名字不能被覆盖。
生成失败时保留旧名字，不要弹任何报错。
短名字最多 15 个字。
现有的删掉旧标题的逻辑先不用改，保持原样。
改动只做在左侧会话列表，不要动聊天页面顶部的标题。
暂不做：英文标题。`,
  badDraft: `每一轮回复结束都重新生成一次名字。
标题支持英文。
短名字最多 20 个字。`,
};

// ───────────────────────────────── L3 编辑重发残留
const L3: Script = {
  id: 'L3', topic: '编辑重发后残留旧消息的排查',
  units: [
    { n: 1, role: 'add', text: '我发现一个问题，编辑一条用户消息再重发以后，下面会残留旧的那条回复。' },
    { n: 2, role: 'retract', text: '嗯不对，残留的不是回复，是原来那条用户消息。' },
    { n: 3, role: 'add', text: '你先查 resend 这个 action，看它有没有把旧的 message id 过滤掉。' },
    { n: 4, role: 'add', text: '相关的状态在 useChatComposerState.ts 里，重发逻辑应该就在那附近。' },
    { n: 5, role: 'retract', text: '也有可能是 ChatMessagesPane 渲染的问题，嗯，先不看渲染，先查状态。' },
    { n: 6, role: 'add', text: '先只定位原因，不要改代码，也不要动测试。' },
    { n: 7, role: 'add', text: '复现步骤：发三条消息，编辑第二条，重发，看底下剩几条。' },
    { n: 8, role: 'command', text: '删掉刚才那段。' },
    { n: 9, role: 'add', text: '复现步骤改一下：发四条消息，编辑第三条，重发。' },
    { n: 10, role: 'add', text: '输出的时候，把原因和你打算怎么修分开写。' },
    { n: 11, role: 'nearmiss', text: '要不要把排查结果里没用的部分删掉再写进 task 文件？不用，直接告诉我就行。' },
  ],
  items: [
    { id: 'I1', kind: 'retract', early: true, ok: (t) => near(t, /残留/, /原来(的)?那条|原(始)?(的)?用户消息|旧的?用户消息|被编辑(前)?的?用户消息/, 25) },
    { id: 'I2', kind: 'identifier', early: true, ident: true, ok: (t) => near(t, /resend/i, /messageid/i, 30) && /过滤/.test(t) },
    { id: 'I3', kind: 'identifier', early: true, ident: true, ok: (t) => active(t, /useChatComposerState/) },
    { id: 'I4', kind: 'retract', ok: (t) => /先(查|检查|排查|看)(状态|useChatComposerState)/.test(t) },
    { id: 'I5', kind: 'negation', ok: (t) => /定位原因/.test(t) && new RegExp(`(不要|不得|不能|别|不)${S}{0,6}(改|修改)${S}{0,4}代码`).test(t) && new RegExp(`(不要|不得|不能|别|不)${S}{0,6}(动|改)${S}{0,4}测试`).test(t) },
    { id: 'I6', kind: 'number', ok: (t) => /4条消息/.test(t) && /第3条/.test(t) && /重发/.test(t) },
    { id: 'I7', kind: 'add', ok: (t) => near(t, /原因/, /修(复)?(方案|思路|计划)|怎么修/, 25) && /分开|分别|分两/.test(t) },
    { id: 'I8', kind: 'nearmiss', ok: (t) => new RegExp(`(不用|不要|无需|不必|别)${S}{0,10}(写|记)${S}{0,8}task`, 'i').test(t) && /直接(告诉|回复|反馈|说)/.test(t) },
  ],
  forbidden: [
    { id: 'F1', kind: 'retract', hit: (t) => active(t, /残留[^。；\n]{0,10}(旧的?)?(那条)?回复/) },
    { id: 'F2', kind: 'retract', hit: (t) => active(t, /ChatMessagesPane/) },
    { id: 'F3', kind: 'command', hit: (t) => /(?<!第)3条消息/.test(t) && active(t, /(?<!第)3条消息/) || active(t, /第2条/) },
  ],
  goodDraft: `编辑一条用户消息并重发后，底部会残留原来那条用户消息。
先查 resend 这个 action，看它是否过滤掉旧的 message id。
相关状态在 useChatComposerState.ts，重发逻辑应在附近。
先查状态，暂不看渲染。
先只定位原因，不要改代码，也不要动测试。
复现步骤：发 4 条消息，编辑第 3 条，重发。
输出时把原因和修复方案分开写。
不用把结果写进 task 文件，直接告诉我。`,
  badDraft: `编辑重发后会残留旧的那条回复。
检查 ChatMessagesPane 的渲染。
复现：发 3 条消息，编辑第 2 条后重发。`,
};

// ───────────────────────────────── L4 生产形态与白屏
const L4: Script = {
  id: 'L4', topic: 'dev server 的生产形态与页面白屏',
  units: [
    { n: 1, role: 'add', text: '现在的 dev server 目标是本地重建最快，我想问有没有一个打包的生产形态，可以长期开着。' },
    { n: 2, role: 'add', text: '我想的是把启动命令换成 vite build --watch，端口还用三零零一。' },
    { n: 3, role: 'retract', text: '嗯不对，端口先不用三零零一，换成三零零二，别和现在那个服务冲突。' },
    { n: 4, role: 'add', text: '另外，我经常看到页面整个自动刷新，白屏几秒又回来，这个也一起查一下原因。' },
    { n: 5, role: 'sidenote', text: 'systemd 托管的事以后再说，这次不做。' },
    { n: 6, role: 'add', text: '产物目录放在 dist，不要覆盖现有的 dist-server。' },
    { n: 7, role: 'command', text: '删掉刚才那段。' },
    { n: 8, role: 'add', text: '产物目录换成 dist-client，不要碰 dist-server。' },
    { n: 9, role: 'add', text: '先别重启三零零一上现在这个服务，我在用它。' },
    { n: 10, role: 'add', text: '刚才说的白屏问题，要抓一下浏览器控制台的报错。' },
    { n: 11, role: 'add', text: '观察时间先定一小时。' },
  ],
  items: [
    { id: 'I1', kind: 'add', early: true, ok: (t) => near(t, /生产形态|打包/, /长期|常驻|一直/, 40) },
    { id: 'I2', kind: 'identifier', early: true, ident: true, ok: (t) => /vitebuild--watch/i.test(t) },
    { id: 'I3', kind: 'retract', early: true, ok: (t) => near(t, /3002/, /端口/, 12) && /冲突/.test(t) },
    { id: 'I4', kind: 'add', early: true, ok: (t) => near(t, /白屏|自动刷新/, /原因|排查|查/, 30) },
    { id: 'I5', kind: 'identifier', ident: true, ok: (t) => /dist-client/.test(t) && new RegExp(`(不(要)?(碰|覆盖|动|改)|避免)${S}{0,8}dist-server`).test(t) },
    { id: 'I6', kind: 'negation', ok: (t) => new RegExp(`(不(要)?(重启|动|碰)|别重启)${S}{0,10}3001`).test(t) },
    { id: 'I7', kind: 'deictic', ok: (t) => near(t, /白屏/, /控制台/, 25) },
    { id: 'I8', kind: 'number', ok: (t) => /1小时|60分钟/.test(t) },
  ],
  forbidden: [
    { id: 'F1', kind: 'retract', hit: (t) => active(t, /端口[^。；\n]{0,8}3001/) },
    { id: 'F2', kind: 'sidenote', hit: (t) => active(t, /systemd/i) },
    { id: 'F3', kind: 'command', hit: (t) => active(t, /(?<![-\w])dist(?![-\w])/) },
  ],
  goodDraft: `评估是否有可以长期开着的打包生产形态。
启动命令换成 vite build --watch，端口用 3002，避免和现有服务冲突。
一并排查页面整个自动刷新、白屏几秒的原因。
产物目录用 dist-client，不要碰 dist-server。
不要重启 3001 上现在的服务。
白屏问题要抓浏览器控制台的报错。
观察时间 1 小时。
暂不做：systemd 托管。`,
  badDraft: `端口使用 3001。
用 systemd 托管服务。
产物目录放在 dist。`,
};

// ───────────────────────────────── L5 活动坞耗时
const L5: Script = {
  id: 'L5', topic: '活动坞上的本轮耗时显示',
  units: [
    { n: 1, role: 'add', text: '活动坞上要显示这一轮已经跑了多久，现在只在轮次结束的时候才更新。' },
    { n: 2, role: 'add', text: '我想让它实时走，而且订阅的时候就从服务端给的起点开始算。' },
    { n: 3, role: 'nearmiss', text: '要不要把现在这个结束时才更新的逻辑删掉？不用，留着当兜底。' },
    { n: 4, role: 'add', text: '文件是 useActivityFreshness，不是 ActivityIndicator。' },
    { n: 5, role: 'add', text: '刷新间隔先定成五百毫秒。' },
    { n: 6, role: 'command', text: '删掉刚才那段。' },
    { n: 7, role: 'add', text: '刷新间隔一秒。' },
    { n: 8, role: 'add', text: '心跳帧不要拿来算时间，只拿来判断有没有卡住。' },
    { n: 9, role: 'add', text: '动画不要加，数字变化就行。' },
    { n: 10, role: 'sidenote', text: '移动端布局以后再调。' },
    { n: 11, role: 'add', text: '最后，上面说的那个显示，空闲的时候要隐藏。' },
  ],
  items: [
    { id: 'I1', kind: 'add', early: true, ok: (t) => near(t, /活动坞/, /(已(经)?(跑|运行)|耗时|用时|elapsed)/i, 40) },
    { id: 'I2', kind: 'add', early: true, ok: (t) => /订阅/.test(t) && new RegExp(`(服务端|服务器)${S}{0,12}(起点|起始|开始时间)`).test(t) },
    { id: 'I3', kind: 'nearmiss', early: true, ok: (t) => near(t, /(轮次)?结束(时)?(才)?更新/, /兜底|保留|留着|不删/, 30) },
    { id: 'I4', kind: 'identifier', early: true, ident: true, ok: (t) => /useActivityFreshness/.test(t) && new RegExp(`(不是|而非|不要|不改|不动)${S}{0,12}ActivityIndicator`).test(t) },
    { id: 'I5', kind: 'number', ok: (t) => near(t, /1秒|1000毫秒/, /刷新|间隔|每/, 12) },
    { id: 'I6', kind: 'negation', ok: (t) => near(t, /心跳/, /(不|别)[^。；\n]{0,6}(算|计)[^。；\n]{0,4}时/, 30) && /卡住|卡死|停滞/.test(t) },
    { id: 'I7', kind: 'negation', ok: (t) => new RegExp(`(不(要)?(加|做|用)|无需|禁用)${S}{0,4}动画`).test(t) },
    { id: 'I8', kind: 'deictic', ok: (t) => near(t, /空闲/, /隐藏|不显示/, 15) },
  ],
  forbidden: [
    { id: 'F1', kind: 'command', hit: (t) => active(t, /500毫秒|0\.5秒|500ms/i) },
    { id: 'F2', kind: 'sidenote', hit: (t) => active(t, /移动端/) },
    { id: 'F3', kind: 'nearmiss', hit: (t) => active(t, /(删除|删掉|移除)[^。；\n]{0,10}(结束|轮次结束)[^。；\n]{0,6}(更新|逻辑)/) },
  ],
  goodDraft: `活动坞显示本轮已经运行的时间。
让它实时走，订阅时从服务端给的起点开始算。
结束时才更新的逻辑保留，当兜底。
改 useActivityFreshness，不是 ActivityIndicator。
刷新间隔 1 秒。
心跳帧不用来算时间，只用来判断有没有卡住。
不要加动画，数字变化即可。
空闲时隐藏这个显示。
移动端布局以后再调。`,
  badDraft: `刷新间隔 500 毫秒。
调整移动端布局。
删除结束时才更新的逻辑。`,
};

export const SCRIPTS: Script[] = [L1, L2, L3, L4, L5];
export const VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'] as const;
