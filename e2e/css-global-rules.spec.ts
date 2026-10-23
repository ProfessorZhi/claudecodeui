/**
 * What the authored global stylesheet does to a rendered transcript.
 *
 * `src/shared/tests/globalCssRules.test.ts` pins the *shape* of the three rules that used to defeat the
 * element they styled; this file reads the rendered result, because a rule's effect is a property of the
 * cascade and not of the rule. One Markdown corpus (a fenced block with lines wider than a phone, a table, a
 * tool result, long inline code) is rendered by the debug-agent seam and read at desktop and phone widths.
 * Every "does not" reading has a control beside it that proves the instrument can see the thing.
 *
 * Set SHOT_PHASE=before|after to write comparison screenshots to .playwright-mcp/css-fix-shots/.
 */
import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

const WORKSPACE_DIR = 'css-global-rules-workspace';
const USERNAME = 'css-global-rules-e2e';
const PASSWORD = 'css-global-rules-e2e-pass';
const F = '```';
const SHOT_PHASE = process.env.SHOT_PHASE;
const SHOT_DIR = path.join(process.cwd(), '.playwright-mcp', 'css-fix-shots');

const FENCE_LINES = [
  'const veryLongIdentifierName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree, argumentNumberFour);',
  'export const another = { key: "value", other: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] };',
  'const third = await fetchSomething(`https://example.com/api/v1/resources/${resourceId}/children?limit=100&offset=0`);',
  'return [veryLongIdentifierName, another, third].map((value) => JSON.stringify(value, null, 2)).join(",");',
];
const INLINE_LONG = 'src/modules/chat/transcript/ResidentSessionBadge.tsx:105:12-and-then-some-more-words-to-force-a-wrap';

const MARKDOWN = [
  `A paragraph with \`short\` and a long path \`${INLINE_LONG}\` inside it.`,
  '',
  '| col a | col b | col c | col d | col e | col f | col g |',
  '|---|---|---|---|---|---|---|',
  '| alpha-alpha-alpha | beta-beta-beta | gamma-gamma-gamma | delta-delta-delta | epsilon-epsilon | zeta-zeta-zeta | eta-eta-eta |',
  '',
  `${F}ts`,
  ...FENCE_LINES,
  F,
].join('\n');

const scenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: 'Global CSS corpus', userText: 'render the corpus', lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'row', role: 'assistant', text: MARKDOWN },
    { at: 0, op: 'row', role: 'assistant', text: 'Closing paragraph so the tool rows are not the last thing.' },
  ],
  expect: { rows: { delta: 2 }, content: { mustContain: ['Closing paragraph'] } },
};

async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') throw new Error('no token for the css-global-rules account');
  return loggedIn.token;
}

let token = '';
let sessionId = '';


test.beforeEach(() => {
  test.setTimeout(120_000);
});

test.beforeAll(async () => {
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  const baseURL = test.info().project.use.baseURL;
  if (!fixtureHome || !baseURL) throw new Error('config must publish QUAY_E2E_DEBUG_AGENT_HOME and a baseURL');
  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const armed = await api.post('/api/debug-agent/scenarios', {
    data: { projectPath: path.join(fixtureHome, WORKSPACE_DIR), scenario },
  });
  const body = await armed.json().catch(() => null);
  expect(armed.ok(), `arming: ${armed.status()} ${JSON.stringify(body)}`).toBe(true);
  sessionId = body.data.sessionId as string;
  const walk = await api.post('/api/debug-agent/clock', { data: { sessionId } });
  expect(walk.ok(), `walk: ${walk.status()}`).toBe(true);
  await api.dispose();
});

const FORMS = {
  desktop: { viewport: { width: 1440, height: 900 }, touch: false },
  phone: { viewport: { width: 390, height: 844 }, touch: true },
} as const;

async function open(browser: Browser, form: keyof typeof FORMS): Promise<{ context: BrowserContext; page: Page }> {
  const baseURL = test.info().project.use.baseURL;
  const { viewport, touch } = FORMS[form];
  const context = await browser.newContext({ baseURL, viewport, hasTouch: touch, isMobile: touch });
  await context.addInitScript(
    ({ k, v }: { k: string; v: string }) => {
      window.localStorage.setItem(k, v);
      window.localStorage.setItem('userLanguage', 'en');
    },
    { k: 'auth-token', v: token },
  );
  const page = await context.newPage();
  let up = false;
  // The first load of a cold Vite client can be pulled out from under the page by a dependency re-optimise.
  for (let attempt = 0; attempt < 4 && !up; attempt++) {
    await page.goto(`/session/${sessionId}`);
    up = await page
      .locator('.chat-messages-pane [data-message-timestamp]')
      .first()
      .waitFor({ state: 'attached', timeout: 25_000 })
      .then(() => true, () => false);
  }
  expect(up, 'the corpus session never rendered').toBe(true);
  await page.locator('.chat-message pre').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(1500);
  const coarse = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
  expect(coarse, `${form}: touch premise`).toBe(FORMS[form].touch);
  return { context, page };
}

async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>) {
  if (!SHOT_PHASE) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}-${SHOT_PHASE}.png`);
  if (target) await target.screenshot({ path: file });
  else await page.screenshot({ path: file });
}

/** The fenced block: a `<pre>` the syntax highlighter styled itself (it writes `white-space: pre` inline). */
const fencedPre = (page: Page) =>
  page.locator('.chat-message pre').filter({ hasText: 'veryLongIdentifierName' }).first();

test('a fenced code block keeps its lines and scrolls sideways, on desktop and on a phone', async ({ browser }) => {
  for (const form of ['desktop', 'phone'] as const) {
    const { context, page } = await open(browser, form);
    try {
      const pre = fencedPre(page);
      await pre.scrollIntoViewIfNeeded();
      const read = await pre.evaluate((el, lines) => {
        const code = el.querySelector('code') as HTMLElement;
        const cs = getComputedStyle(el);
        const ccs = getComputedStyle(code);
        const lineHeight = parseFloat(ccs.lineHeight) || parseFloat(ccs.fontSize) * 1.5;
        return {
          preWhiteSpace: cs.whiteSpace,
          codeWhiteSpace: ccs.whiteSpace,
          codeWordBreak: ccs.wordBreak,
          overflowX: cs.overflowX,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          codeRows: Math.round(code.getBoundingClientRect().height / lineHeight),
          sourceLines: lines,
        };
      }, FENCE_LINES.length);
      // The block is wider than this viewport only on the phone; on a desktop column it may fit.
      expect.soft(read.preWhiteSpace, `${form}: <pre> white-space`).toMatch(/^pre$/);
      expect.soft(read.codeWhiteSpace, `${form}: <code> white-space`).toMatch(/^pre$/);
      expect.soft(read.codeWordBreak, `${form}: <code> word-break`).toBe('normal');
      expect.soft(read.codeRows, `${form}: rows drawn vs source lines`).toBe(read.sourceLines);
      if (form === 'phone') {
        await shot(page, 'fenced-code-phone', pre);
        expect(read.scrollW, 'a 120-char line must overflow a 390px phone').toBeGreaterThan(read.clientW + 40);
      }
    } finally {
      await context.close();
    }
  }
});

test('a horizontal swipe scrolls the code block on a phone (the table scroller is the control)', async ({ browser }) => {
  const { context, page } = await open(browser, 'phone');
  try {
    const cdp = await context.newCDPSession(page);
    const swipe = async (el: ReturnType<Page['locator']>) => {
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const box = await el.boundingBox();
      if (!box) throw new Error('no box');
      const x = Math.round(box.x + Math.min(box.width - 20, box.width * 0.75));
      const y = Math.round(box.y + Math.min(box.height / 2, 24));
      const before = await el.evaluate((n: HTMLElement) => n.scrollLeft);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 14; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - (200 * i) / 14, y }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(450);
      return { before, after: await el.evaluate((n: HTMLElement) => n.scrollLeft) };
    };
    const control = await swipe(page.locator('.chat-message table').first().locator('xpath=..'));
    expect(control.after, 'control: the swipe harness must move a scroller that is scrollable by construction').toBeGreaterThan(control.before);
    const block = await swipe(fencedPre(page));
    expect(block.after, 'the swipe must move the code block').toBeGreaterThan(block.before);
    await cdp.detach();
  } finally {
    await context.close();
  }
});

test('inline code breaks a long path instead of pushing the row wider', async ({ browser }) => {
  const { context, page } = await open(browser, 'phone');
  try {
    const read = await page.evaluate((text) => {
      const code = [...document.querySelectorAll('.chat-message code')].find((c) => !c.closest('pre') && c.textContent === text) as HTMLElement;
      const cs = getComputedStyle(code);
      const msg = code.closest('.chat-message') as HTMLElement;
      return {
        wordBreak: cs.wordBreak,
        overflowWrap: cs.overflowWrap,
        whiteSpace: cs.whiteSpace,
        codeRight: code.getBoundingClientRect().right,
        msgRight: msg.getBoundingClientRect().right,
        lines: code.getClientRects().length,
      };
    }, INLINE_LONG);
    expect(read.whiteSpace).toBe('pre-wrap');
    expect(read.wordBreak, 'inline code must not use break-all (it splits every word mid-letter)').toBe('normal');
    expect(read.overflowWrap).toBe('anywhere');
    expect(read.lines, 'a 100-char path on a 390px phone has to wrap').toBeGreaterThan(1);
    expect(read.codeRight).toBeLessThanOrEqual(read.msgRight + 1);
  } finally {
    await context.close();
  }
});

test('a tapped button keeps its colours: a touch device has no hover to undo', async ({ browser }) => {
  const { context, page } = await open(browser, 'phone');
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const tagged = await page.evaluate(() => {
      const out: string[] = [];
      const seen = new Set<string>();
      let i = 0;
      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) continue;
        const bg = getComputedStyle(b).backgroundColor;
        const m = /rgba?\(([^)]*)\)/.exec(bg);
        const alpha = m && m[1].split(',').length > 3 ? parseFloat(m[1].split(',')[3]) : m ? 1 : 0;
        if (!(alpha > 0.3)) continue;
        const sig = `${bg}|${getComputedStyle(b).color}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        b.setAttribute('data-hover-probe', String(i));
        out.push(String(i++));
        if (out.length >= 6) break;
      }
      return out;
    });
    expect(tagged.length, 'the page must have coloured buttons to probe').toBeGreaterThanOrEqual(2);
    const read = (i: string) =>
      page.evaluate((k) => {
        const cs = getComputedStyle(document.querySelector(`[data-hover-probe="${k}"]`) as HTMLElement);
        return `${cs.backgroundColor}|${cs.color}|${cs.opacity}`;
      }, i);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const changed: string[] = [];
    for (const i of tagged) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-hover-probe="${i}"]` });
      const rest = await read(i);
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      // Past the longest transition on any button: reading at once returns the rest value everywhere.
      await page.waitForTimeout(450);
      const hovered = await read(i);
      if (rest !== hovered) changed.push(`${rest}  ->  ${hovered}`);
      if (SHOT_PHASE && i === tagged[0]) {
        // A clipped page capture: an element capture waits for the node to be stable, and a node held in a
        // forced pseudo-state never settles for it.
        const box = await page.locator(`[data-hover-probe="${i}"]`).boundingBox();
        if (box) {
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const pad = 12;
          await page.screenshot({
            path: path.join(SHOT_DIR, `hovered-button-phone-${SHOT_PHASE}.png`),
            clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad },
            timeout: 10_000,
          });
        }
      }
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
    expect(changed, 'forced :hover must not repaint a button on a coarse, hover-less device').toEqual([]);
    await cdp.detach();
  } finally {
    await context.close();
  }
});

test('a mouse still gets hover styling (control for the touch reading above)', async ({ browser }) => {
  const { context, page } = await open(browser, 'desktop');
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const count = await page.evaluate(() => {
      let i = 0;
      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) continue;
        b.setAttribute('data-hover-probe', String(i++));
        if (i >= 40) break;
      }
      return i;
    });
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    let changed = 0;
    for (let i = 0; i < count; i++) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-hover-probe="${i}"]` });
      const read = () =>
        page.evaluate((k) => {
          const cs = getComputedStyle(document.querySelector(`[data-hover-probe="${k}"]`) as HTMLElement);
          return `${cs.backgroundColor}|${cs.color}|${cs.opacity}`;
        }, i);
      const rest = await read();
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      await page.waitForTimeout(450);
      if ((await read()) !== rest) changed++;
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
    expect(changed, 'at least one desktop button must visibly respond to :hover, or the touch reading proves nothing').toBeGreaterThan(0);
    await cdp.detach();
  } finally {
    await context.close();
  }
});

test('in PWA mode the app shell clears the status bar and a drawer scrim still covers it', async ({ browser }) => {
  const { context, page } = await open(browser, 'phone');
  try {
    await page.getByRole('button', { name: /open menu/i }).first().click();
    const scrim = page.getByRole('button', { name: /close sidebar/i }).first();
    await scrim.waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      document.body.classList.add('pwa-mode');
      document.documentElement.style.setProperty('--header-total-padding', '24px');
    });
    await page.waitForTimeout(300);
    await shot(page, 'drawer-top-strip-pwa-phone');
    await page.evaluate(() => {
      document.body.classList.remove('pwa-mode');
      document.documentElement.style.removeProperty('--header-total-padding');
    });
    const tops = await page.evaluate(() => {
      const top = (e: Element | null) => Math.round((e?.getBoundingClientRect().top ?? NaN) * 10) / 10;
      const shell = document.querySelector('[data-app-shell]') ?? document.querySelector('.fixed.inset-0');
      const scrimEl = [...document.querySelectorAll('button.fixed.inset-0')].find((b) => b.getBoundingClientRect().height > 0) ?? null;
      const rest = { shell: top(shell), scrim: top(scrimEl) };
      document.body.classList.add('pwa-mode');
      document.documentElement.style.setProperty('--header-total-padding', '24px');
      const pwa = { shell: top(shell), scrim: top(scrimEl) };
      document.body.classList.remove('pwa-mode');
      document.documentElement.style.removeProperty('--header-total-padding');
      return { rest, pwa, hasMarker: !!document.querySelector('[data-app-shell]') };
    });
    expect(tops.hasMarker, 'the page root must carry data-app-shell').toBe(true);
    expect(tops.pwa.shell, 'control: the shell is shifted down by the safe-area padding').toBeGreaterThan(tops.rest.shell);
    expect(tops.pwa.scrim, 'the scrim must keep covering the top strip').toBe(tops.rest.scrim);
  } finally {
    await context.close();
  }
});
