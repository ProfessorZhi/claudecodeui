/**
 * The verdict rubric for the EXTENSION set (`n01`…`n05`), same ✅/◐/❌ semantics as `judge.mts`.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT MORE `case` ARMS IN `judge.mts`. `judge.mts` is the
 * authority the C/E readings (✅58 ◐18 ❌4) were frozen against; adding arms to its switch would
 * change the file whose output those numbers are, which is exactly the kind of silent drift the
 * freeze exists to prevent. So the extension set gets its own rubric, and any comparison across
 * the two sets is at the level of COUNTS, never of individual rules.
 *
 * WHAT THIS RUBRIC IS FOR. The extension scripts carry four properties the authored set has no
 * instance of, and each gets an explicit failure clause rather than being left to the general
 * impression:
 *   · a RESTART the speaker performs aloud ("嗯不对，先只说组件本身") — keeping the abandoned
 *     clause as well is a ◐, not a ✅, because the abandoned clause is the thing being withdrawn;
 *   · an IMPLICIT referent ("左侧那个会话列表", "上次那个偏置的实验") — inventing a concrete
 *     name for it is ❌, because the speaker never said one and the agent would act on a name
 *     that was never spoken. This is the same hazard the context arms produce by injection; here
 *     it is produced by the audio alone;
 *   · code-switching inside one clause;
 *   · a NEGATION carrying the instruction's force ("别纠结…", "不打包、不缓存").
 *
 * The insertion axis is NOT here: it belongs to the arm (names injected by the context), not to
 * the clip, and it lives in `e-ctx-an.mts`.
 */

export type ExtVerdict = '✅' | '◐' | '❌';

/** `ins` is the instruction the model wrote up — the thing an agent would receive. */
export function judgeExt(clip: string, ins: string): [ExtVerdict, string] {
  const t = ins.toLowerCase();
  const has = (re: RegExp) => re.test(ins);
  const low = (re: RegExp) => re.test(t);

  switch (clip) {
    // 我想在 composer 旁边加一个展示用的组件，就是语音回放那个 pill。嗯不对，先只说组件本身。
    // 位置放在 ChatComposer 点 t s x 四百四十二行旁边，显示 blob 的基本信息就行。
    // The speaker spells the path aloud ("ChatComposer 点 t s x") and the line ("四百四十二行"),
    // so the correct write-up is the exact filename plus the number. A case or hyphen variant is
    // ◐ and not ❌ on purpose: on a case-sensitive filesystem `chat-composer.tsx` does not exist,
    // so an agent told to edit it FAILS LOUDLY — which is the opposite of the d01 hazard, where
    // the substituted name was another real file and nothing announced the error.
    case 'n01-o65': {
      const exact = has(/`?ChatComposer\.tsx`?/);
      const variant = !exact && has(/`?chat[-_]?composer\.tsx`?/i);
      const line = has(/44[0-9]/);
      if (exact && line) return ['✅', ''];
      if (variant && line) return ['◐', 'filename case/hyphen'];
      if (exact && !line) return ['◐', 'line lost'];
      if (has(/composer/i)) return ['◐', 'component only'];
      return ['❌', 'request lost'];
    }

    // 刚才我用咱们这个应用发现一个问题：编辑并重发之后，底下会残留一条旧消息。
    // 嗯，不是重发那条，是原来那条。你查一下 resend 那个 action 有没有过滤掉旧的 message id。
    //
    // The correction here settles WHICH message lingers. A clause barring the writing-up from
    // dropping the second half of it was removed after it scored 「残留一条旧消息（不是重发的那条）」
    // as ◐: that sentence already names the subject, so the omitted half changes nothing an agent
    // would do. What the clause is for is the opposite error — asserting that the RE-SENT message
    // is the one left behind — so that is what it now tests.
    case 'n02-o65':
      //
      // The negative matters and a first attempt ignored it: 「残留一条旧消息——**不是**重发的那条，是原来那条」
      // is the correct reading, and a bare `残留…重发那条` pattern scored it ❌. The clause now
      // only fires when the re-sent message is asserted to be the one left behind, which is the
      // one thing the speaker's correction rules out.
      const wrong = /残留[^。；]{0,24}(重发(的)?那(条|个))/.exec(ins);
      if (wrong && !/不是|而非|而不是|不是重发/.test(wrong[0])) return ['❌', 'wrong subject'];
      if (!has(/重发/)) return ['❌', 'premise lost'];
      if (has(/resend/) && has(/message\s*id/i) && has(/残留|旧消息|旧的消息/)) return ['✅', ''];
      if (has(/resend/)) return ['◐', 'action named, target vague'];
      if (has(/过滤/) || has(/filter/i)) return ['◐', 'filter asked, action unnamed'];
      return ['❌', 'requirement lost'];

    // 你看一下左侧那个会话列表，名字都取第一次对话的内容，特别长。
    // 我想加一个自动改名的机制，拿会话最后一段内容生成一个短名字。你先讨论方案，别直接写。
    case 'n03-o65':
      // The speaker never names the list or the model. Naming one is the failure this clip exists for.
      if (has(/SessionList|sessionList|会话列表组件|ConversationList/)) return ['❌', 'referent invented'];
      if (has(/别直接写|先讨论|不要直接(写|实现)|先(只)?讨论/) === false) return ['❌', '“先讨论别写” lost'];
      if (has(/会话列表/) && has(/自动(改名|命名)|重命名/) && has(/最后一段|末段/)) return ['✅', ''];
      if (has(/会话列表/) && has(/自动(改名|命名)|重命名/)) return ['◐', 'source of the name vague'];
      return ['◐', 'fact garbled'];

    // 上次那个偏置的实验我看过了。它把 use voice input 修成驼峰那个是对的，但是带点的路径反而被切碎了。
    // 这些其实都算有效，别纠结合成语音还是真按键录音。
    //
    // THE FIRST VERSION OF THIS ARM WAS WRONG IN BOTH DIRECTIONS, and both are worth naming
    // because they are the two ways a hand-written rubric fails:
    //   · it demanded the literal 「别纠结」, so the faithful paraphrase 「不要区分」 scored ❌
    //     (a false failure on a legitimate rewrite);
    //   · it looked only at the negation, so the real fabrication — the model turning the
    //     speaker's 「这些其实都算有效」 into a work item 「…需要修复」 — scored ✅.
    // The three clauses below are ordered by what an agent would actually do with the text.
    case 'n04-o65': {
      // ① The speaker refers to the experiment deictically and never names it. Resolving it into
      // a concrete project name is the same hazard the context arms inject — here produced by the
      // audio alone, under a list that supplies plausible names to resolve it with.
      if (has(/`?(ds-bias|identifierFidelity|voice-omni-written|written-ds|voice-webm-asr-paired-quality)`?/)) return ['❌', 'referent invented'];
      // ② 「都算有效」 is a conclusion, not a ticket. Asserting a repair adds a requirement that
      // was never spoken — and it contradicts the sentence right before it.
      if (has(/需要修复|需修复|要修复|应该修复|需要修正|需修正|需要修改|应该修正|需要处理|需要改进/)) return ['❌', 'repair invented'];
      // ③ The negation carries the instruction's force; dropping it changes what the agent does.
      if (!has(/别纠结|不用纠结|不要纠结|别区分|不用区分|不要区分|不需要区分|不必区分|无需区分|不应区分/)) return ['❌', 'negation lost'];
      if (has(/useVoiceInput/)) return ['✅', ''];
      return ['◐', 'negation kept, identifier not assembled'];
    }

    // 现在这个 dev server 的优化目标是本地重建最快，不打包、不缓存、秒级 HMR。
    // 我就想问，咱们有没有一个打包的生产形态？还有，我经常看到页面整个自动刷新，白屏几秒又回来。
    case 'n05-o65':
      if (!has(/打包|生产(形态|构建|版本)/)) return ['❌', 'the question lost'];
      if (has(/不打包/) && has(/不缓存/) && has(/HMR/i)) return ['✅', ''];
      if (has(/生产(形态|构建|版本)/)) return ['◐', 'negation or HMR dropped'];
      return ['◐', 'fact garbled'];
  }
  return ['?', 'unknown clip'];
}
