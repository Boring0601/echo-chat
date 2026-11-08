/**
 * 用本机 Edge 的 CDP 做一次真实浏览器冒烟：
 * 首页 → 开场白 → 记忆捕获 → 新话题 → 记忆保留 → 移动端抽屉 → 截图。
 *
 * 这个脚本本身零依赖；在 Windows 沙箱内启动 Edge 需要放宽沙箱，
 * 因此只在需要验收时手动运行：
 *   node scripts/ui-check.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PROFILE = path.join(ROOT, '.tmp', `edge-profile-${Date.now()}`);
const BASE_URL = process.env.ECHO_URL || 'http://127.0.0.1:4173';
const ORIGIN = new URL(BASE_URL).origin;
const DEBUG_PORT = Number(process.env.ECHO_DEBUG_PORT) || 9333;
const OPENING = '你好，我们一起聊聊吧？';
const MEMORY_TEXT = '我叫林一，在做毕业设计，养了一只叫豆豆的猫，最近总失眠。';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

function findEdge() {
  return EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
}

async function waitForHttp(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Edge 还没起来。
    }
    await delay(200);
  }
  throw new Error(`等待超时：${url}`);
}

function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    events.push(message);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
      once: true
    });
  });

  function send(method, params = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { socket, ready, send, events };
}

async function run() {
  const edge = findEdge();
  if (!edge) throw new Error('没有找到 Edge，请设置 EDGE_PATH。');
  await mkdir(ARTIFACTS, { recursive: true });
  await mkdir(PROFILE, { recursive: true });

  const health = await waitForHttp(`${BASE_URL}/api/health`, 3000);
  if (!health.ok) throw new Error('服务器健康检查失败');

  const SKIP_EDGE = process.env.ECHO_SKIP_EDGE === '1';
  let child = null;
  if (!SKIP_EDGE) {
    child = spawn(
      edge,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-pings',
        '--hide-scrollbars',
        '--window-size=1440,900',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${PROFILE}`,
        'about:blank'
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    child.on('error', (error) => {
      console.error('Edge 启动失败：', error);
    });
  } else {
    console.log(`· 复用手动启动的 Edge · CDP ${DEBUG_PORT}`);
  }

  let cdp;
  let diagnose = null;
  let collectedEvents = [];
  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((target) => target.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('没有找到可调试的页面');
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    const { send, events } = cdp;
    collectedEvents = events;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    async function evaluate(expression, awaitPromise = false) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            '页面执行出错'
        );
      }
      return result.result?.value;
    }

    async function waitFor(expression, timeoutMs = 12000, label = expression) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(expression)) return;
        await delay(120);
      }
      throw new Error(`等待超时：${label}`);
    }

    async function screenshot(name) {
      const result = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      });
      const file = path.join(ARTIFACTS, name);
      await writeFile(file, Buffer.from(result.data, 'base64'));
      console.log(`  ✓ 截图 ${path.relative(ROOT, file)}`);
    }

    diagnose = async () => {
      const domState = await evaluate(`(() => {
        const data = JSON.parse(localStorage.getItem('echo.v1') || 'null');
        return {
          view: document.querySelector('#landing').hidden ? 'chat' : 'landing',
          topicCount: data?.topics?.length ?? 0,
          topics: (data?.topics ?? []).map((topic) => ({ title: topic.title, persona: topic.personaId, messages: topic.messages.length })),
          activeTopicId: data?.activeTopicId ?? null,
          greetingNodes: document.querySelectorAll('.msg--greeting').length,
          assistantNodes: document.querySelectorAll('.msg--assistant').length,
          typing: Boolean(document.querySelector('.msg--typing')),
          sendDisabled: document.querySelector('#send-btn').disabled,
          composerHint: document.querySelector('#composer-hint').textContent,
          drawerOpen: document.querySelector('#drawer').classList.contains('is-open'),
          drawerHidden: document.querySelector('#drawer').hidden,
          modalHidden: document.querySelector('#modal-root').hidden,
          toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent),
          body: document.body.innerText.slice(0, 1200)
        };
      })()`);
      const errors = collectedEvents
        .filter((event) => event.method === 'Runtime.exceptionThrown')
        .map((event) => event.params?.exceptionDetails?.exception?.description)
        .filter(Boolean);
      return { domState, errors };
    };

    const checks = [];
    function check(label, condition, detail = '') {
      checks.push({ label, ok: Boolean(condition), detail });
      console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`);
    }

    console.log('· 打开首页并清空本地数据');
    await send('Storage.clearDataForOrigin', {
      origin: ORIGIN,
      storageTypes: 'local_storage'
    });
    await send('Page.navigate', { url: BASE_URL });
    await waitFor('document.readyState === "complete"', 12000, 'load');
    await waitFor(
      'document.querySelector(".starter-chip") && !document.querySelector("#landing").hidden',
      8000,
      'landing'
    );
    await delay(1100);

    check(
      '首页标题出现',
      await evaluate('document.body.innerText.includes("值得被记住")')
    );
    check(
      '首页处于可见状态',
      await evaluate('!document.querySelector("#landing").hidden')
    );
    check(
      '四种人格概率卡齐全',
      (await evaluate('document.querySelectorAll(".persona-strip__item").length')) === 4
    );
    check(
      '示例话题存在',
      (await evaluate('document.querySelectorAll(".starter-chip").length')) >= 3
    );
    check(
      '首页提供默认话题入口',
      await evaluate(
        'Boolean(document.querySelector("#start-default")) && document.querySelector("#start-default").textContent.includes("直接开始")'
      )
    );
    await screenshot('desktop-landing.png');
    await evaluate('document.querySelector("#start-default").click()');
    await waitFor(
      '!document.querySelector("#setup").hidden && document.querySelectorAll(".gender-card").length === 4',
      6000,
      'default topic setup'
    );
    check(
      '默认入口先进入性别步骤',
      await evaluate('!document.querySelector("#setup-gender-step").hidden')
    );
    await evaluate('document.querySelector("#setup-close").click()');
    await waitFor('!document.querySelector("#landing").hidden', 6000, 'default topic cancel');
    check(
      '取消默认入口后回到首页',
      await evaluate('!document.querySelector("#landing").hidden')
    );

    console.log('· 移动端首页 390×844');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await delay(350);
    check(
      '移动端首页无横向滚动',
      await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    );
    await screenshot('mobile-landing.png');
    await evaluate('document.querySelector("[data-theme-toggle]").click()');
    await delay(450);
    await screenshot('mobile-landing-dark.png');
    await evaluate('document.querySelector("[data-theme-toggle]").click()');
    await delay(350);
    await send('Emulation.clearDeviceMetricsOverride');
    await delay(350);
    check(
      '清空数据后仍是首页',
      await evaluate('!document.querySelector("#landing").hidden')
    );

    console.log('· 点击示例话题，进入性别选择');
    await evaluate('document.querySelector(".starter-chip").click()');
    await waitFor(
      '!document.querySelector("#setup").hidden && document.querySelectorAll(".gender-card").length === 4',
      6000,
      'setup gender step'
    );
    check(
      '开始对话先进入性别步骤',
      await evaluate('!document.querySelector("#setup-gender-step").hidden')
    );
    check(
      '性别提供 男/女/无/随机',
      await evaluate(
        '[...document.querySelectorAll(".gender-card")].map(n => n.dataset.gender).join(",") === "male,female,none,random"'
      )
    );
    await delay(450);
    await screenshot('desktop-setup-gender.png');

    console.log('· 移动端性别页 390×844');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await delay(350);
    check(
      '移动端性别页无横向滚动',
      await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    );
    await screenshot('mobile-setup-gender.png');
    await send('Emulation.clearDeviceMetricsOverride');
    await delay(350);

    console.log('· 选择女性，检查对应人设名单');
    await evaluate('document.querySelector(\'[data-gender="female"]\').click()');
    await waitFor(
      '!document.querySelector("#setup-persona-step").hidden && document.querySelectorAll(".name-tile").length === 8',
      6000,
      'female names'
    );
    const femaleNames = await evaluate(
      '[...document.querySelectorAll(".name-tile")].map((node) => node.textContent.trim())'
    );
    check('女性名单为 8 位', femaleNames.length === 8, femaleNames.join(' / '));
    check(
      '女性名单包含苏晚晴且不含周叙白',
      femaleNames.includes('苏晚晴') && !femaleNames.includes('周叙白')
    );
    check(
      '人设选项只显示姓名',
      femaleNames.every(
        (name) =>
          name.length <= 5 && !name.includes('岁') && !name.includes('花店')
      )
    );
    check(
      '性别上下文显示女性',
      await evaluate('document.querySelector("#setup-gender-context").textContent.includes("女")')
    );
    await delay(450);
    await screenshot('desktop-setup-names.png');

    console.log('· 移动端人设名单 390×844');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await delay(350);
    check(
      '移动端人设页无横向滚动',
      await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    );
    await screenshot('mobile-setup-names.png');
    await send('Emulation.clearDeviceMetricsOverride');
    await delay(350);

    console.log('· 长按“苏晚晴”，检查人物简介');
    await evaluate(`
      (() => {
        const tile = [...document.querySelectorAll('.name-tile')]
          .find((node) => node.textContent.trim() === '苏晚晴');
        tile.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          pointerType: 'mouse',
          button: 0,
          clientX: 40,
          clientY: 40
        }));
      })()
    `);
    await waitFor(
      'document.querySelector(".modal.is-open") && document.body.innerText.includes("独立花店店主") && document.body.innerText.includes("花店")',
      5000,
      'bio modal'
    );
    check(
      '长按显示完整人物简介',
      await evaluate('document.body.innerText.includes("坐这儿，不急着说")')
    );
    await screenshot('desktop-setup-bio.png');
    await evaluate(
      '[...document.querySelectorAll(".modal button")].find((node) => node.textContent.includes("就选 TA")).click()'
    );

    await waitFor(
      'document.querySelector(".msg--opening") && !document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled',
      15000,
      'character opening'
    );
    const firstOpening = await evaluate(
      'document.querySelector(".msg--opening .msg__text")?.textContent?.trim() || ""'
    );
    check(
      '选定角色后不使用固定开场',
      firstOpening !== OPENING && firstOpening.length > 6,
      firstOpening
    );
    check(
      '首条消息先给具身动作',
      /^（.+）/.test(firstOpening),
      firstOpening
    );
    check(
      '人格揭示条包含苏晚晴',
      await evaluate(
        'document.body.innerText.includes("本次相遇") && document.body.innerText.includes("苏晚晴")'
      )
    );
    check(
      '人格卡展示年龄与职业',
      await evaluate(
        'document.querySelector("#persona-card")?.innerText.includes("30岁") && document.querySelector("#persona-card")?.innerText.includes("独立花店店主")'
      )
    );
    check(
      '至少收到一条角色开场',
      (await evaluate('document.querySelectorAll(".msg--assistant").length')) >= 1
    );
    check(
      '开场回复不是占位空话',
      (await evaluate(
        '[...document.querySelectorAll(".msg--assistant .msg__text")].slice(-1)[0].textContent.trim().length'
      )) >= 6
    );
    await delay(250);
    await screenshot('desktop-chat.png');

    console.log('· 发送含姓名/宠物/目标/状态的句子，检查记忆');
    await evaluate(`
      (() => {
        const input = document.querySelector('#message-input');
        input.value = ${JSON.stringify(MEMORY_TEXT)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#composer').requestSubmit();
      })()
    `);
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.body.innerText.includes("猫 · 豆豆")',
      15000,
      'memory captured + reply'
    );
    const memoryCount = Number(await evaluate('document.querySelector("#memory-count").textContent'));
    check('记忆至少抽取 4 条', memoryCount >= 4, `count=${memoryCount}`);
    check(
      '豆豆进入记忆面板',
      await evaluate('document.body.innerText.includes("宠物 · 猫 · 豆豆")')
    );
    check(
      '画像开始变化',
      await evaluate('document.body.innerText.includes("先让人缓口气")')
    );
    check(
      '自我披露不会被角色知识边界拦截',
      await evaluate(
        '!document.querySelector("#message-list").innerText.includes("这个我不太懂")'
      )
    );
    await screenshot('desktop-memory.png');

    console.log('· 苏晚晴的领域知识');
    await evaluate(`
      (() => {
        const input = document.querySelector('#message-input');
        input.value = '我想送花给一个刚失恋的朋友，送什么好？';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#composer').requestSubmit();
      })()
    `);
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.body.innerText.includes("洋甘菊")',
      15000,
      'flower answer'
    );
    check(
      '角色领域知识回答符合苏晚晴',
      await evaluate(
        'document.body.innerText.includes("洋甘菊") && document.body.innerText.includes("不用急着好起来")'
      )
    );
    check(
      '知识回答没有出戏或元话术',
      await evaluate(
        '!document.body.innerText.includes("作为 AI") && !document.body.innerText.includes("希望对你有帮助")'
      )
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(250);
    await screenshot('desktop-knowledge.png');

    console.log('· 否定句与沉默');
    const refusalSend = async (text) => {
      await evaluate(`
        (() => {
          const input = document.querySelector('#message-input');
          input.value = ${JSON.stringify(text)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#composer').requestSubmit();
        })()
      `);
    };
    const lastAssistantText = () =>
      evaluate(
        '[...document.querySelectorAll(".msg--assistant .msg__text")].at(-1)?.textContent?.trim() || ""'
      );

    await refusalSend('我不想休息');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 4',
      15000,
      'refusal reply'
    );
    const firstRefusal = await lastAssistantText();
    check(
      '否定句先回应否定，而不是继续安慰',
      firstRefusal.includes('不想歇') || firstRefusal.includes('那就不歇'),
      firstRefusal
    );
    check('否定句先给具身动作', /^（.+）/.test(firstRefusal), firstRefusal);
    check(
      '否定句没有反着劝“好好休息”',
      !firstRefusal.includes('那你要好好休息'),
      firstRefusal
    );

    await refusalSend('我不想休息');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 5',
      15000,
      'second refusal reply'
    );
    const secondRefusal = await lastAssistantText();
    const firstRefusalAction = firstRefusal.match(/^（([^）]+)）/)?.[1];
    const secondRefusalAction = secondRefusal.match(/^（([^）]+)）/)?.[1];
    check(
      '连续否定会换动作与措辞',
      firstRefusal !== secondRefusal && firstRefusalAction !== secondRefusalAction,
      `${firstRefusal} / ${secondRefusal}`
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-refusal.png');

    await refusalSend('我不想说');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 6',
      15000,
      'silence reply'
    );
    const silenceReply = await lastAssistantText();
    check(
      '沉默时不用“想聊什么”硬cue',
      !silenceReply.includes('想聊什么'),
      silenceReply
    );
    check(
      '沉默时允许动作留白',
      /^（.+）/.test(silenceReply) &&
        (silenceReply.includes('不想说就不说') || silenceReply.includes('那就先不说')),
      silenceReply
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-silence.png');

    console.log('· 日常开场与记忆提问');
    await refusalSend('我们聊聊天吧');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 7',
      15000,
      'chat opener'
    );
    const chatOpener = await lastAssistantText();
    check(
      '聊聊天时用待客动作开场',
      /^（.+）/.test(chatOpener) &&
        (chatOpener.includes('从哪儿说起') ||
          chatOpener.includes('想说什么') ||
          chatOpener.includes('聊会儿')),
      chatOpener
    );
    check(
      '聊聊天时不假装记住',
      !/记住了|知道了|我懂了/.test(chatOpener),
      chatOpener
    );

    await refusalSend('今天天气不错');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 8',
      15000,
      'weather smalltalk'
    );
    const weather = await lastAssistantText();
    check(
      '天气闲聊有正常反应',
      /^（.+）/.test(weather) &&
        (weather.includes('挺好') || weather.includes('太阳') || weather.includes('坐会儿')),
      weather
    );
    check(
      '天气闲聊不用记忆指令回应',
      !/记住了|知道了|我懂了/.test(weather),
      weather
    );

    await refusalSend('你记住什么了？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 9',
      15000,
      'memory question'
    );
    const memoryQuestion = await lastAssistantText();
    check(
      '被问记住什么时先解释或认错',
      memoryQuestion.includes('嘴瓢') ||
        memoryQuestion.includes('记岔') ||
        memoryQuestion.includes('没记住'),
      memoryQuestion
    );
    check(
      '记忆提问不跳到审问式问题',
      !memoryQuestion.includes('那你想怎么办'),
      memoryQuestion
    );

    await refusalSend('明天给我留一束花');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 10',
      15000,
      'memory confirm'
    );
    const memoryConfirm = await lastAssistantText();
    check(
      '明确交代事情时才确认记住',
      memoryConfirm.includes('记下了') || memoryConfirm.includes('记着'),
      memoryConfirm
    );
    check('确认记忆时有具身动作', /^（.+）/.test(memoryConfirm), memoryConfirm);
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-daily.png');

    console.log('· 反问与问号');
    await refusalSend('我来你这儿不就是为了聊聊吗？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 11',
      15000,
      'corrective reply'
    );
    const correctiveReply = await lastAssistantText();
    check(
      '反问吐槽时先认错',
      /^（.+）/.test(correctiveReply) &&
        (correctiveReply.includes('走神') ||
          correctiveReply.includes('说岔') ||
          correctiveReply.includes('这嘴')),
      correctiveReply
    );
    check(
      '反问吐槽时不再硬套“得你自己定”',
      !correctiveReply.includes('得你自己定') &&
        !correctiveReply.includes('那你想怎么办'),
      correctiveReply
    );

    await refusalSend('？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 12',
      15000,
      'confused reply'
    );
    const confusedReply = await lastAssistantText();
    check(
      '只发问号时放弃僵硬逻辑重开',
      /^（.+）/.test(confusedReply) &&
        (confusedReply.includes('说错什么了吗') ||
          confusedReply.includes('哪句说岔') ||
          confusedReply.includes('说错') ||
          confusedReply.includes('嘴瓢')),
      confusedReply
    );

    await refusalSend('你觉得这花好看吗');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 13',
      15000,
      'casual question'
    );
    const casualReply = await lastAssistantText();
    check(
      '日常闲问正常回答，不甩“得你自己定”',
      (casualReply.includes('我觉得') ||
        casualReply.includes('我看行') ||
        casualReply.includes('挺好') ||
        casualReply.includes('还行')) &&
        !casualReply.includes('得你自己定') &&
        !casualReply.includes('做不了主'),
      casualReply
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-corrective.png');

    console.log('· 主客体识别');
    await refusalSend('今天生意怎么样？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 14',
      15000,
      'work question'
    );
    const workAnswer = await lastAssistantText();
    check(
      '问生意时第一句直接回答',
      /^（.+）/.test(workAnswer) &&
        workAnswer.includes('今儿还行') &&
        workAnswer.includes('百合'),
      workAnswer
    );
    check(
      '问生意时不用“你先说说”打太极',
      !workAnswer.includes('你先说说') && !workAnswer.includes('你先说'),
      workAnswer
    );

    await refusalSend('你吃饭了吗？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 15',
      15000,
      'eat question'
    );
    const eatAnswer = await lastAssistantText();
    check(
      '问吃饭时直接回答吃了没',
      eatAnswer.includes('吃了') && !eatAnswer.includes('听起来挺充实的'),
      eatAnswer
    );

    await refusalSend('你今天过得好不好？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 16',
      15000,
      'day question'
    );
    const dayAnswer = await lastAssistantText();
    check(
      '问今天过得好不好时回答自己，不把问题当成用户倾诉',
      (dayAnswer.includes('站了一天') || dayAnswer.includes('还行')) &&
        !dayAnswer.includes('听起来挺充实的'),
      dayAnswer
    );

    await refusalSend('我在问你');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 17',
      15000,
      'subject check'
    );
    const subjectAnswer = await lastAssistantText();
    check(
      '“我在问你”后重新回答上一个关于你的问题',
      subjectAnswer.includes('是我答偏了') &&
        (subjectAnswer.includes('站了一天') || subjectAnswer.includes('还行')),
      subjectAnswer
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-selfqa.png');

    console.log('· 明确要求分享');
    await refusalSend('给我讲个故事，分享一件事');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 18',
      15000,
      'story reply'
    );
    const storyReply = await lastAssistantText();
    check(
      '要求分享时讲角色自己的具体小事',
      storyReply.length > 30 &&
        !/这得看情况|看心情|你想听什么|你觉得呢/.test(storyReply),
      storyReply
    );
    check(
      '要求分享时不敷衍成坐/喝水',
      !/^(?:（[^）]+）)?(?:坐|喝水|先坐会儿)[。！？!?]?$/.test(storyReply),
      storyReply
    );
    check('要求分享时使用具身动作', /^（.+）/.test(storyReply), storyReply);

    await refusalSend('还有呢');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 19',
      15000,
      'next story'
    );
    const nextStory = await lastAssistantText();
    check(
      '追问还有呢时换新内容，不甩“这得看情况”',
      nextStory !== storyReply &&
        !/这得看情况|看心情|你想听什么|你觉得呢/.test(nextStory),
      nextStory
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(250);
    await screenshot('desktop-share.png');

    console.log('· 尊重生理边界');
    await refusalSend('我有点累');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 20',
      15000,
      'tired care'
    );
    const tiredCare = await lastAssistantText();
    check(
      '累的时候给物理照顾，不做心理分析',
      /^（.+）/.test(tiredCare) &&
        (tiredCare.includes('坐下') || tiredCare.includes('缓缓')) &&
        tiredCare.includes('今天怎么这么累') &&
        !/心里|心事|看起来你有心事/.test(tiredCare),
      tiredCare
    );

    await refusalSend('没事，就是有点累');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 21',
      15000,
      'dismiss care'
    );
    const dismissCare = await lastAssistantText();
    check(
      '用户说没事时顺坡下驴，不强行拉扯心理压力',
      /^（.+）/.test(dismissCare) &&
        (dismissCare.includes('没事就行') || dismissCare.includes('椅子在这儿')) &&
        !/你肯定有事|心里|心事/.test(dismissCare) &&
        !dismissCare.includes('？'),
      dismissCare
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-boundary.png');

    await refusalSend('我也没说我在干什么呀');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 22',
      15000,
      'misread correction'
    );
    const misreadReply = await lastAssistantText();
    check(
      '被质疑脑补时先承认瞎猜，不用“你呢”转移',
      /^（.+）/.test(misreadReply) &&
        (misreadReply.includes('脑补') ||
          misreadReply.includes('职业病') ||
          misreadReply.includes('瞎猜')) &&
        !misreadReply.includes('你呢'),
      misreadReply
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-misread.png');

    await refusalSend('聊天');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 23',
      15000,
      'icebreak'
    );
    const icebreak = await lastAssistantText();
    check(
      '极简回复“聊天”会主动抛出具体话题',
      /^（.+）/.test(icebreak) &&
        (icebreak.includes('想聊点轻松的') ||
          icebreak.includes('吐槽') ||
          icebreak.includes('案子')),
      icebreak
    );
    check('破冰时不机械反问“你呢”', !icebreak.includes('你呢'), icebreak);

    await refusalSend('在和你聊天');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 24',
      15000,
      'you chat'
    );
    const youChat = await lastAssistantText();
    check(
      '用户说“在和你聊天”后不反问你呢',
      /^（.+）/.test(youChat) && !youChat.includes('你呢'),
      youChat
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-icebreak.png');

    await refusalSend('什么是光合作用');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 25',
      15000,
      'academic knowledge'
    );
    const academic = await lastAssistantText();
    check(
      '基础学科知识能答出关键结论',
      (academic.includes('叶绿体') ||
        academic.includes('二氧化碳') ||
        academic.includes('氧气')) &&
        !/我不太懂|这个我不懂|不知道/.test(academic),
      academic
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-knowledge-academic.png');

    console.log('· 精准吸收与常识回正');
    await refusalSend('我有点累');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 26',
      15000,
      'tired before reason'
    );
    await refusalSend('作业太多了');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 27',
      15000,
      'reason follow-up'
    );
    const reasonReply = await lastAssistantText();
    check(
      '吸收“作业太多”的原因，不问“具体说说”',
      reasonReply.includes('作业这么多') &&
        reasonReply.includes('考试') &&
        !/说吧|具体说说|今天过得还行|纸巾/.test(reasonReply),
      reasonReply
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-absorb.png');

    await refusalSend('钢琴有几个键');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 28',
      15000,
      'common sense'
    );
    const commonSense = await lastAssistantText();
    check(
      '客观常识直接回答，不装高冷推诿',
      commonSense.includes('88') &&
        !/说具体点|先把前提说清楚/.test(commonSense),
      commonSense
    );
    await evaluate(
      'document.querySelector("#message-scroll").scrollTop = document.querySelector("#message-scroll").scrollHeight'
    );
    await delay(200);
    await screenshot('desktop-common-sense.png');

    await refusalSend('你在干嘛');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 29',
      15000,
      'direct status'
    );
    const directStatus = await lastAssistantText();
    check(
      '问“在干嘛”直接回答，并自然把话头递回去',
      /^（.+）/.test(directStatus) &&
        /理花|忙|手里|店/.test(directStatus) &&
        (directStatus.includes('在忙什么') || directStatus.includes('？')),
      directStatus
    );
    await screenshot('desktop-direct-status.png');

    await refusalSend('你这转移话题的能力太差了');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 30',
      15000,
      'meta critique rescue'
    );
    const rescue = await lastAssistantText();
    check(
      '被吐槽时停止原动作并先自救',
      (rescue.includes('没接好') ||
        rescue.includes('演技差') ||
        rescue.includes('逻辑模型') ||
        rescue.includes('翻车')) &&
        !/改文案|看图纸|推眼镜/.test(rescue),
      rescue
    );
    await screenshot('desktop-rescue.png');

    await refusalSend('没事不能找你？');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 31',
      15000,
      'soften'
    );
    const soften = await lastAssistantText();
    check(
      '被反怼时立刻软化，不继续高冷',
      (soften.includes('没有不耐烦') ||
        soften.includes('没接好') ||
        soften.includes('我哪有那个意思') ||
        soften.includes('冤枉')) &&
        !/坐不坐都行|数据跑不了|先坐会儿/.test(soften),
      soften
    );
    await screenshot('desktop-soften.png');

    await refusalSend('我是说你这件事很暖心');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 32',
      15000,
      'subject fix'
    );
    const subjectFix = await lastAssistantText();
    check(
      '主语纠偏时承认听岔并顺着接',
      (subjectFix.includes('听岔了') || subjectFix.includes('主语')) &&
        !/后来呢|说吧，我听着|这事听着不轻/.test(subjectFix),
      subjectFix
    );
    await screenshot('desktop-subject-fix.png');

    await refusalSend('你是什么工作');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 33',
      15000,
      'identity setting'
    );
    const identitySetting = await lastAssistantText();
    check(
      '基础身份职业直接回答，不说不记得',
      (identitySetting.includes('花店') || identitySetting.includes('开花店')) &&
        !/我也不知道|我不记得了|说点别的/.test(identitySetting),
      identitySetting
    );

    await refusalSend('……');
    await waitFor(
      '!document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled && document.querySelectorAll(".msg--assistant").length >= 34',
      15000,
      'baffle'
    );
    const baffle = await lastAssistantText();
    check(
      '无语符号反思失误，不当累安慰',
      (baffle.includes('说错什么') || baffle.includes('哪句说岔')) &&
        !/先歇着|是不是累了/.test(baffle),
      baffle
    );
    await screenshot('desktop-baffle.png');

    console.log('· 打开记忆档案');
    await evaluate('document.querySelector("#header-memory").click()');
    await waitFor('document.querySelector("#drawer").classList.contains("is-open")', 4000);
    await delay(380);
    check(
      '档案里能看到姓名与宠物',
      await evaluate(
        'document.querySelector("#drawer")?.innerText.includes("林一") && document.querySelector("#drawer")?.innerText.includes("豆豆")'
      )
    );
    check(
      '记忆档案包含原文存档',
      await evaluate(
        'document.querySelector("#drawer .transcript")?.textContent.includes("原文存档") && document.querySelector("#drawer .transcript")?.textContent.includes("我叫林一")'
      )
    );
    check(
      '原文存档保留用户原话',
      await evaluate(
        `document.querySelector("#drawer .transcript")?.textContent.includes(${JSON.stringify(MEMORY_TEXT)})`
      )
    );
    await screenshot('desktop-memory-drawer.png');
    await evaluate(`
      (() => {
        const details = document.querySelector("#drawer .transcript");
        if (details) details.open = true;
        const drawer = document.querySelector("#drawer");
        drawer.scrollTop = drawer.scrollHeight;
      })()
    `);
    await delay(300);
    await screenshot('desktop-transcript.png');
    await evaluate('document.querySelector("#drawer [data-close]").click()');
    await delay(250);

    console.log('· 开启新话题，选择男性 + 随机人设');
    await waitFor('!document.querySelector("#send-btn").disabled', 4000, 'composer ready');
    await evaluate('document.querySelector("#new-topic-header").click()');
    await waitFor(
      '!document.querySelector("#setup").hidden && document.querySelectorAll(".gender-card").length === 4',
      6000,
      'second setup'
    );
    await evaluate('document.querySelector(\'[data-gender="male"]\').click()');
    await waitFor(
      '!document.querySelector("#setup-persona-step").hidden && document.querySelectorAll(".name-tile").length === 8',
      6000,
      'male names'
    );
    const maleNames = await evaluate(
      '[...document.querySelectorAll(".name-tile")].map((node) => node.textContent.trim())'
    );
    check(
      '男性名单包含周叙白且不含苏晚晴',
      maleNames.includes('周叙白') && !maleNames.includes('苏晚晴')
    );
    await evaluate('document.querySelector("#setup-random-persona").click()');
    await waitFor(
      'JSON.parse(localStorage.getItem("echo.v1") || "{}").topics?.length >= 2 && document.querySelector(".msg--opening") && !document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled',
      15000,
      'second character opening'
    );
    const secondOpening = await evaluate(
      'document.querySelector(".msg--opening .msg__text")?.textContent?.trim() || ""'
    );
    check(
      '新话题由角色自然开场',
      secondOpening !== OPENING && secondOpening.length > 10,
      secondOpening
    );
    check(
      '随机人设落到了男性角色',
      await evaluate(
        `(() => {
          const current = JSON.parse(localStorage.getItem('echo.v1')).topics[0];
          return current.gender === 'male' && current.personaId !== 'none';
        })()`
      )
    );
    check(
      '跨话题记忆仍在',
      await evaluate('document.body.innerText.includes("豆豆")')
    );
    check(
      '出现第二次人格相遇',
      await evaluate('document.body.innerText.includes("第 2 次相遇")')
    );
    await delay(300);
    await screenshot('desktop-second-topic.png');

    console.log('· 检查四种人格弹层');
    await evaluate('document.querySelector("#persona-chip").click()');
    await waitFor('document.querySelector(".modal.is-open")', 4000);
    await delay(300);
    check(
      '概率说明含 15% 与四种人格',
      await evaluate(
        'document.querySelector(".modal")?.innerText.includes("时而傲娇白切黑") && document.querySelector(".modal")?.innerText.includes("15%")'
      )
    );
    await screenshot('desktop-personas.png');
    await evaluate('document.querySelector(".modal [data-close]").click()');
    await delay(250);

    console.log('· 随机性别');
    await evaluate('document.querySelector("#new-topic-header").click()');
    await waitFor(
      '!document.querySelector("#setup").hidden && document.querySelectorAll(".gender-card").length === 4',
      6000,
      'random gender setup'
    );
    await evaluate('document.querySelector(\'[data-gender="random"]\').click()');
    await waitFor(
      '!document.querySelector("#setup-persona-step").hidden && document.querySelectorAll(".name-tile").length === 8',
      6000,
      'random gender names'
    );
    check(
      '随机性别解析并筛出 8 位',
      await evaluate(
        'document.querySelector("#setup-gender-context").textContent.includes("随机结果") && document.querySelectorAll(".name-tile").length === 8'
      )
    );
    await evaluate('document.querySelector("#setup-close").click()');
    await waitFor('!document.querySelector("#workspace").hidden', 4000, 'back to chat');

    console.log('· 无人设 + 不限定性别');
    await evaluate('document.querySelector("#new-topic-header").click()');
    await waitFor(
      '!document.querySelector("#setup").hidden && document.querySelectorAll(".gender-card").length === 4',
      6000,
      'third setup'
    );
    await evaluate('document.querySelector(\'[data-gender="none"]\').click()');
    await waitFor(
      '!document.querySelector("#setup-persona-step").hidden && document.querySelectorAll(".name-tile").length === 16',
      6000,
      'all names'
    );
    check(
      '不限定性别展示全部 16 人',
      (await evaluate('document.querySelectorAll(".name-tile").length')) === 16
    );
    check(
      '名单同时包含男女角色',
      await evaluate(
        'document.body.innerText.includes("苏晚晴") && document.body.innerText.includes("周叙白")'
      )
    );
    await evaluate('document.querySelector("#setup-no-persona").click()');
    await waitFor(
      'JSON.parse(localStorage.getItem("echo.v1") || "{}").topics?.length >= 3 && document.querySelector(".msg--greeting") && !document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled',
      15000,
      'no persona greeting'
    );
    check(
      '无人设仍有固定开场白',
      (await evaluate(
        'document.querySelector(".msg--greeting .msg__text")?.textContent?.trim() || ""'
      )) === OPENING
    );
    check(
      '无人设卡片说明性别与角色状态',
      await evaluate(
        'document.querySelector("#persona-card")?.innerText.includes("无人设") && document.querySelector("#persona-card")?.innerText.includes("AI 性别：不限定")'
      )
    );
    check(
      '无人设揭示条出现',
      await evaluate('document.body.innerText.includes("本次相遇 · 无人设")')
    );
    await delay(350);
    await screenshot('desktop-none.png');

    console.log('· 首页默认话题 + 无人设');
    await evaluate('document.querySelector("#workspace-brand").click()');
    await waitFor('!document.querySelector("#landing").hidden', 6000, 'back to landing');
    await evaluate('document.querySelector("#start-default").click()');
    await waitFor(
      '!document.querySelector("#setup").hidden && document.querySelectorAll(".gender-card").length === 4',
      6000,
      'default topic setup'
    );
    await evaluate('document.querySelector(\'[data-gender="none"]\').click()');
    await waitFor(
      '!document.querySelector("#setup-persona-step").hidden && document.querySelectorAll(".name-tile").length === 16',
      6000,
      'default topic names'
    );
    await evaluate('document.querySelector("#setup-no-persona").click()');
    await waitFor(
      'JSON.parse(localStorage.getItem("echo.v1") || "{}").topics?.length >= 4 && document.querySelector(".msg--greeting") && !document.querySelector(".msg--typing") && !document.querySelector("#send-btn").disabled',
      15000,
      'default topic greeting'
    );
    check(
      '默认话题 + 无人设逐字发送固定开场白',
      (await evaluate(
        'document.querySelector(".msg--greeting .msg__text")?.textContent?.trim() || ""'
      )) === OPENING
    );
    await delay(300);
    await screenshot('desktop-default-topic.png');

    console.log('· 移动端 390×844');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await evaluate('location.reload()');
    await waitFor('document.readyState === "complete"', 12000, 'mobile reload');
    await waitFor(
      'document.querySelector(".chat-header") && !document.querySelector("#workspace").hidden',
      8000,
      'mobile chat'
    );
    await delay(500);
    check(
      '移动端无横向滚动',
      await evaluate(
        'document.documentElement.scrollWidth <= window.innerWidth + 1'
      )
    );
    await screenshot('mobile-chat.png');

    await evaluate('document.querySelector("#open-topics").click()');
    await waitFor('document.querySelector("#workspace").classList.contains("is-topics-open")', 4000);
    await delay(420);
    await screenshot('mobile-topics.png');
    await evaluate('document.querySelector("#topics-close").click()');
    await delay(300);

    await evaluate('document.querySelector("#open-insights").click()');
    await waitFor(
      'document.querySelector("#workspace").classList.contains("is-insights-open")',
      4000
    );
    await delay(420);
    await screenshot('mobile-insights.png');
    await evaluate('document.querySelector("#insights-close").click()');
    await delay(300);

    const consoleErrors = events
      .filter(
        (event) =>
          (event.method === 'Runtime.exceptionThrown') ||
          (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error') ||
          (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error')
      )
      .map((event) => {
        if (event.method === 'Runtime.exceptionThrown') {
          return event.params?.exceptionDetails?.exception?.description || 'exception';
        }
        if (event.method === 'Log.entryAdded') return event.params?.entry?.text || 'log error';
        return (event.params?.args ?? []).map((arg) => arg.value ?? arg.description).join(' ');
      })
      .filter(Boolean);

    check('浏览器无 console error', consoleErrors.length === 0, consoleErrors.join(' | '));

    const failed = checks.filter((item) => !item.ok);
    console.log('');
    console.log(`结果：${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length > 0) {
      throw new Error(`页面检查失败：${failed.map((item) => item.label).join('、')}`);
    }
  } catch (error) {
    if (diagnose) {
      try {
        console.error('诊断：', JSON.stringify(await diagnose(), null, 2));
      } catch {
        // ignore diagnostic failure
      }
    }
    throw error;
  } finally {
    try {
      cdp?.socket?.close();
    } catch {
      // ignore
    }
    if (child) child.kill('SIGTERM');
    await delay(500);
    if (!SKIP_EDGE) {
      try {
        await rm(PROFILE, { recursive: true, force: true });
      } catch {
        // Edge 可能还握着 profile，留给 .tmp 清理。
      }
    }
  }
}

run().catch((error) => {
  console.error('');
  console.error('UI 检查失败：', error.message);
  process.exitCode = 1;
});
