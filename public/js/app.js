/**
 * 回声 ECHO 前端。
 * 原生 ES Modules，无框架、无构建、无外部请求（除非服务端配置了大模型）。
 */

import {
  PERSONAS,
  OPENING_LINE,
  GENDER_CHOICES,
  characterNamesByArchetype,
  charactersForGender,
  genderLabel,
  personaById,
  personaPercent,
  profileForTopic,
  resolveGender,
  selectCharacter
} from './personas.js';
import {
  DEFAULT_TRAITS,
  MEMORY_CATEGORIES,
  TRAIT_LABELS,
  categoryLabel,
  deriveHabits,
  extractMemories,
  formatMemoryLabel,
  inferTraits,
  mergeMemories,
  sanitizeMemoryCandidate,
  sanitizeTraits
} from './memory.js';
import { composeCharacterOpening, composeLocalReply } from './engine.js';
import { secureRandom } from './rng.js';
import {
  appendMessage,
  countMessages,
  countUserMessages,
  createTopic,
  exportPayload,
  findTopic,
  listUserMessages,
  loadData,
  saveData,
  titleFromText
} from './store.js';

const STARTERS = [
  '最近有点累，但说不清为什么',
  '我好像把生活过成了待办清单',
  '说件今天发生的小事'
];

const EMPTY_SUGGESTIONS = [
  '说说今天发生的一件小事',
  '我最近有点累',
  '聊一个我最近在想的问题'
];

const dom = {
  landing: document.getElementById('landing'),
  workspace: document.getElementById('workspace'),
  setup: document.getElementById('setup'),
  setupStepLabel: document.getElementById('setup-step-label'),
  setupClose: document.getElementById('setup-close'),
  setupMain: document.getElementById('setup-main'),
  setupGenderStep: document.getElementById('setup-gender-step'),
  setupPersonaStep: document.getElementById('setup-persona-step'),
  setupGenderGrid: document.getElementById('setup-gender-grid'),
  setupGenderContext: document.getElementById('setup-gender-context'),
  setupNameGrid: document.getElementById('setup-name-grid'),
  setupNoPersona: document.getElementById('setup-no-persona'),
  setupRandomPersona: document.getElementById('setup-random-persona'),
  setupBack: document.getElementById('setup-back'),
  startForm: document.getElementById('start-form'),
  topicInput: document.getElementById('topic-input'),
  startDefault: document.getElementById('start-default'),
  starterChips: document.getElementById('starter-chips'),
  personaStrip: document.getElementById('persona-strip'),
  continueBtn: document.getElementById('continue-btn'),
  landingBrand: document.getElementById('landing-brand'),
  workspaceBrand: document.getElementById('workspace-brand'),
  landingPersonas: document.getElementById('landing-personas'),
  topicsPanel: document.getElementById('topics-panel'),
  topicList: document.getElementById('topic-list'),
  topicCount: document.getElementById('topic-count'),
  memoryCount: document.getElementById('memory-count'),
  openMemory: document.getElementById('open-memory'),
  openSettings: document.getElementById('open-settings'),
  newTopicSidebar: document.getElementById('new-topic-sidebar'),
  chatTitle: document.getElementById('chat-title'),
  chatSubtitle: document.getElementById('chat-subtitle'),
  personaChip: document.getElementById('persona-chip'),
  personaChipSigil: document.getElementById('persona-chip-sigil'),
  personaChipName: document.getElementById('persona-chip-name'),
  personaChipProb: document.getElementById('persona-chip-prob'),
  headerMemory: document.getElementById('header-memory'),
  headerMemoryCount: document.getElementById('header-memory-count'),
  newTopicHeader: document.getElementById('new-topic-header'),
  openTopics: document.getElementById('open-topics'),
  topicsClose: document.getElementById('topics-close'),
  openInsights: document.getElementById('open-insights'),
  insightsClose: document.getElementById('insights-close'),
  insightsPanel: document.getElementById('insights-panel'),
  skipLink: document.querySelector('.skip-link'),
  messageScroll: document.getElementById('message-scroll'),
  messageList: document.getElementById('message-list'),
  jumpLatest: document.getElementById('jump-latest'),
  composer: document.getElementById('composer'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
  composerHint: document.getElementById('composer-hint'),
  modeLabel: document.getElementById('mode-label'),
  personaCard: document.getElementById('persona-card'),
  traits: document.getElementById('traits'),
  traitSample: document.getElementById('trait-sample'),
  habits: document.getElementById('habits'),
  memoryPreview: document.getElementById('memory-preview'),
  insightsMemory: document.getElementById('insights-memory'),
  overlay: document.getElementById('overlay'),
  drawer: document.getElementById('drawer'),
  modalRoot: document.getElementById('modal-root'),
  toastRoot: document.getElementById('toast-root'),
  themeToggles: document.querySelectorAll('[data-theme-toggle]')
};

const state = {
  data: loadData(),
  view: 'landing',
  activeTopicId: null,
  generating: false,
  llm: { enabled: false, model: '' },
  layerOpen: false,
  lastFocus: null,
  lastLlmErrorAt: 0,
  saveWarned: false,
  setup: null,
  setupReturnFocus: null,
  ignoreOverlayUntil: 0
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function button(className, text, label) {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  return node;
}

function getActiveTopic() {
  return findTopic(state.data, state.activeTopicId);
}

function getActivePersona() {
  return profileForTopic(getActiveTopic());
}

function displayPersonaName(persona) {
  return persona?.isNone ? '无人设' : persona?.name ?? '回声';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function relativeTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const now = new Date();
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (sameDay(date, now)) return `今天 ${formatTime(timestamp)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${formatTime(timestamp)}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function todayStamp() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function saveNow() {
  const result = saveData(state.data);
  if (!result.ok && !state.saveWarned) {
    state.saveWarned = true;
    showToast('本地存储不可用，这段对话可能不会被保存。');
  }
}

function applyTheme(theme, options = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#0d0d0d' : '#f3f3f3');
  document.querySelectorAll('.theme-label').forEach((label) => {
    label.textContent = next === 'dark' ? '纸' : '墨';
  });
  if (options.persist !== false) {
    state.data.settings.theme = next;
    saveNow();
  }
}

function toggleTheme() {
  applyTheme(state.data.settings.theme === 'dark' ? 'light' : 'dark');
}

function renderStarterChips() {
  dom.starterChips.replaceChildren();
  for (const text of STARTERS) {
    const chip = button('starter-chip', text);
    chip.addEventListener('click', () => openSetup(text));
    dom.starterChips.append(chip);
  }
}

function renderPersonaStrip() {
  dom.personaStrip.replaceChildren();
  PERSONAS.forEach((persona, index) => {
    const card = button('persona-strip__item');
    card.setAttribute('aria-label', `查看${persona.name}，出现概率${personaPercent(persona)}`);
    const top = el('div', 'persona-strip__top');
    top.append(
      el('span', 'persona-strip__index', String(index + 1).padStart(2, '0')),
      el('span', 'persona-strip__sigil', persona.sigil)
    );
    card.append(
      top,
      el('p', 'persona-strip__name', persona.name),
      el('p', 'persona-strip__tag', persona.tagline),
      el('span', 'persona-strip__prob', `${personaPercent(persona)} · 4 位角色`)
    );
    card.addEventListener('click', openPersonaInfo);
    dom.personaStrip.append(card);
  });
}

function renderView() {
  const hasTopics = state.data.topics.length > 0;
  if (!hasTopics && state.view === 'chat') state.view = 'landing';
  dom.landing.hidden = state.view !== 'landing';
  dom.workspace.hidden = state.view !== 'chat';
  dom.setup.hidden = state.view !== 'setup';
  dom.continueBtn.hidden = !hasTopics;
  if (dom.skipLink) {
    dom.skipLink.href =
      state.view === 'setup'
        ? '#setup-main'
        : state.view === 'chat'
          ? '#message-input'
          : '#topic-input';
  }

  if (state.view === 'setup') {
    renderSetup();
    updateDocumentTitle();
    return;
  }

  if (state.view === 'landing') {
    updateDocumentTitle();
    return;
  }

  const topic = getActiveTopic();
  if (!topic) {
    state.view = 'landing';
    dom.landing.hidden = false;
    dom.workspace.hidden = true;
    updateDocumentTitle();
    return;
  }

  renderHeader(topic);
  renderTopics();
  renderMessages(topic);
  renderInsights(topic);
  renderComposerState();
  updateDocumentTitle();
  requestAnimationFrame(() => scrollToBottom(true));
}

function updateDocumentTitle() {
  const topic = getActiveTopic();
  if (state.view === 'setup') {
    document.title = '选择人设 · 回声 ECHO';
    return;
  }
  document.title =
    state.view === 'chat' && topic
      ? `${topic.title} · 回声 ECHO`
      : '回声 ECHO · 会记住你的对话者';
}

function personaModeLabel(topic, persona) {
  if (persona?.isNone) return `无人设 · ${genderLabel(topic?.gender)}`;
  if (persona?.isCharacter) {
    return topic?.selectionMode === 'specific'
      ? `${persona.archetypeName} · 指定`
      : `${persona.archetypeName} · ${personaPercent(persona)} · 随机`;
  }
  return `${persona?.name ?? '经典人格'} · ${personaPercent(persona)}`;
}

function renderHeader(topic) {
  const persona = profileForTopic(topic);
  dom.chatTitle.textContent = topic.title;
  dom.chatSubtitle.textContent = `跨话题记忆 · ${state.data.memories.length} 条`;
  dom.personaChipSigil.textContent = persona.sigil;
  dom.personaChipName.textContent = displayPersonaName(persona);
  dom.personaChipProb.textContent = persona.isNone
    ? ''
    : topic.selectionMode === 'specific' && persona.isCharacter
      ? '指定'
      : personaPercent(persona);
  dom.personaChip.title = persona.isNone
    ? '无人设'
    : persona.isCharacter
      ? `${persona.name} · ${persona.archetypeName}`
      : persona.name;
  dom.headerMemoryCount.textContent = String(state.data.memories.length);
  dom.memoryCount.textContent = String(state.data.memories.length);
  dom.topicCount.textContent = String(state.data.topics.length);
}

function renderTopics() {
  dom.topicList.replaceChildren();
  dom.topicCount.textContent = String(state.data.topics.length);
  const topics = [...state.data.topics].sort((a, b) => b.updatedAt - a.updatedAt);
  if (topics.length === 0) {
    dom.topicList.append(el('p', 'topic-empty', '还没有对话。'));
    return;
  }

  for (const topic of topics) {
    const persona = profileForTopic(topic);
    const row = el('div', 'topic-row');
    const open = button('topic-open');
    open.dataset.openTopic = topic.id;
    if (topic.id === state.activeTopicId) {
      open.classList.add('is-active');
      open.setAttribute('aria-current', 'page');
    }
    open.append(
      el('span', 'topic-open__title', topic.title),
      el(
        'span',
        'topic-open__meta',
        `${persona.sigil} ${displayPersonaName(persona)} · ${relativeTime(topic.updatedAt)}`
      )
    );
    const remove = button('topic-delete', '×', `删除对话：${topic.title}`);
    remove.dataset.deleteTopic = topic.id;
    row.append(open, remove);
    dom.topicList.append(row);
  }
}

function personaMessageMeta(persona, message) {
  const name = displayPersonaName(persona);
  if (message.kind === 'greeting' || message.kind === 'opening') {
    return `第一次见面 · ${name}`;
  }
  if (message.kind === 'followup') return `${name} · 刚刚`;
  return `${name} · ${formatTime(message.createdAt)}`;
}

function buildMessageNode(topic, message, animate = false) {
  const persona = profileForTopic(topic);

  if (message.role === 'system') {
    const divider = el('div', 'conversation-divider');
    divider.setAttribute('role', 'separator');
    divider.append(el('span', '', message.text));
    if (animate) divider.classList.add('is-new');
    return divider;
  }

  if (message.role === 'user') {
    const article = el('article', 'msg msg--user');
    if (animate) article.classList.add('is-new');
    const bubble = el('div', 'msg__bubble');
    bubble.append(el('p', 'msg__text', message.text));
    article.append(bubble);
    article.title = formatTime(message.createdAt);
    return article;
  }

  const article = el('article', 'msg msg--assistant');
  if (message.kind === 'greeting') article.classList.add('msg--greeting');
  if (message.kind === 'opening') article.classList.add('msg--opening');
  if (message.kind === 'followup') article.classList.add('msg--soft');
  if (animate) article.classList.add('is-new');
  const sigil = el('div', 'msg__sigil', persona.sigil);
  sigil.setAttribute('aria-hidden', 'true');
  const body = el('div', 'msg__body');
  body.append(
    el('div', 'msg__meta', personaMessageMeta(persona, message)),
    el('p', 'msg__text', message.text)
  );
  article.append(sigil, body);
  return article;
}

function renderMessages(topic) {
  dom.messageList.replaceChildren();
  for (const message of topic.messages) {
    dom.messageList.append(buildMessageNode(topic, message, false));
  }
  if (!state.generating && countUserMessages(topic) === 0) {
    appendSuggestions(topic);
  }
  updateJumpButton();
}

function appendMessageNode(topic, message, animate = true) {
  if (state.activeTopicId !== topic.id) return;
  dom.messageList.append(buildMessageNode(topic, message, animate));
  if (message.role === 'user') removeSuggestions();
  maybeScroll();
}

function appendSuggestions(topic) {
  removeSuggestions();
  if (!topic || state.activeTopicId !== topic.id || countUserMessages(topic) > 0) return;
  const wrap = el('div', 'suggestions');
  wrap.append(el('p', 'suggestions__label', '你可以这样开始'));
  const row = el('div', 'suggestions__row');
  for (const text of EMPTY_SUGGESTIONS) {
    const chip = button('suggestion-chip', text);
    chip.addEventListener('click', () => sendMessageText(text));
    row.append(chip);
  }
  wrap.append(row);
  dom.messageList.append(wrap);
  updateJumpButton();
}

function removeSuggestions() {
  document.querySelectorAll('.suggestions').forEach((node) => node.remove());
}

function showTyping() {
  if (!getActiveTopic()) return null;
  const persona = getActivePersona();
  const article = el('article', 'msg msg--assistant msg--typing');
  const sigil = el('div', 'msg__sigil', persona.sigil);
  sigil.setAttribute('aria-hidden', 'true');
  const body = el('div', 'msg__body');
  const dots = el('span', 'typing');
  dots.setAttribute('aria-label', '回声正在输入');
  for (let index = 0; index < 3; index += 1) dots.append(el('i'));
  body.append(
    el('div', 'msg__meta', `${displayPersonaName(persona)} · 正在想`),
    dots
  );
  article.append(sigil, body);
  dom.messageList.append(article);
  maybeScroll();
  return article;
}

function removeTyping(node) {
  if (node) node.remove();
}

function isNearBottom() {
  const node = dom.messageScroll;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 140;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    dom.messageScroll.scrollTop = dom.messageScroll.scrollHeight;
  }
  updateJumpButton();
}

function maybeScroll() {
  requestAnimationFrame(() => {
    if (isNearBottom()) dom.messageScroll.scrollTop = dom.messageScroll.scrollHeight;
    updateJumpButton();
  });
}

function updateJumpButton() {
  const hasMessages = dom.messageList.children.length > 0;
  dom.jumpLatest.hidden = !hasMessages || isNearBottom();
}

function renderInsights(topic = getActiveTopic()) {
  if (!topic) {
    dom.personaCard.replaceChildren();
    dom.traits.replaceChildren();
    dom.habits.replaceChildren();
    dom.memoryPreview.replaceChildren();
    return;
  }
  const persona = profileForTopic(topic);
  renderPersonaCard(persona, topic);
  renderTraits();
  renderHabits();
  renderMemoryPreview();
  renderHeader(topic);
}

function renderPersonaCard(persona, topic) {
  dom.personaCard.replaceChildren();
  const head = el('div', 'panel-card__head');
  const wrap = el('div', 'panel-card__title');
  wrap.append(
    el('p', 'panel-card__name', persona.isNone ? '回声' : persona.name),
    el('p', 'panel-card__prob', personaModeLabel(topic, persona))
  );
  head.append(el('span', 'panel-card__sigil', persona.sigil), wrap);

  const identity = el(
    'p',
    'panel-card__identity',
    persona.isCharacter
      ? `${genderLabel(persona.gender)} · ${persona.age}岁 · ${persona.occupation}`
      : persona.isNone
        ? `AI 性别：${genderLabel(topic.gender)}`
        : '经典人格 · 未指定角色'
  );
  const tagline = el('p', 'panel-card__tagline', persona.tagline);
  const quote = el(
    'p',
    'panel-card__quote',
    `“${persona.signature || persona.preview}”`
  );
  const habits = el('ul', 'mini-habits');
  for (const habit of persona.habits) habits.append(el('li', '', habit));

  const links = el('div', 'panel-card__links');
  if (persona.isCharacter) {
    const bio = button('link-btn', '查看人物简介');
    bio.addEventListener('click', () => openCharacterBio(persona));
    links.append(bio);
  } else if (persona.isNone) {
    const about = button('link-btn', '什么是无人设');
    about.addEventListener('click', openNoPersonaInfo);
    links.append(about);
  }
  const more = button('link-btn', '看清四种性格');
  more.addEventListener('click', openPersonaInfo);
  links.append(more);

  const foot = el('div', 'panel-card__foot');
  foot.append(
    el('span', 'panel-card__round', `第 ${state.data.topics.length} 次相遇`),
    links
  );
  dom.personaCard.append(head, identity, tagline, quote, habits, foot);
  dom.chatSubtitle.textContent = `跨话题记忆 · ${state.data.memories.length} 条`;
}

function countAllUserMessages() {
  return state.data.topics.reduce(
    (total, topic) => total + countUserMessages(topic),
    0
  );
}

function renderTraits() {
  const sample = countAllUserMessages();
  dom.traitSample.textContent = `${sample} 句`;
  dom.traits.replaceChildren();
  const traits = sanitizeTraits(state.data.traits);
  for (const [key, label] of Object.entries(TRAIT_LABELS)) {
    const row = el('div', 'trait-row');
    const head = el('div', 'trait-row__head');
    head.append(
      el('span', 'trait-row__label', label),
      el('span', 'trait-row__value', sample === 0 ? '—' : String(traits[key]))
    );
    const bar = el('div', 'trait-bar');
    const fill = el('span', 'trait-bar__fill');
    fill.style.width = `${sample === 0 ? 50 : traits[key]}%`;
    if (sample === 0) fill.classList.add('is-waiting');
    bar.append(fill);
    row.append(head, bar);
    dom.traits.append(row);
  }
  if (sample === 0) {
    dom.traits.append(el('p', 'trait-note', '再聊几句，它才开始认识你。'));
  }
}

function renderHabits() {
  dom.habits.replaceChildren();
  const habits = deriveHabits(state.data.traits);
  habits.forEach((habit, index) => {
    const item = el('li', 'habit-item');
    item.append(
      el('span', 'habit-item__index', String(index + 1).padStart(2, '0')),
      el('span', 'habit-item__text', habit)
    );
    dom.habits.append(item);
  });
  if (countAllUserMessages() === 0) {
    dom.habits.append(el('p', 'habit-note', '聊过之后，这些会随你的表达方式变化。'));
  }
}

function renderMemoryPreview() {
  dom.memoryPreview.replaceChildren();
  const memories = [...state.data.memories]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 6);
  if (memories.length === 0) {
    dom.memoryPreview.append(el('p', 'memory-empty', '它还没有记住什么。聊几句吧。'));
    return;
  }
  for (const memory of memories) {
    const item = button('memory-mini');
    item.dataset.memoryOpen = 'true';
    item.append(
      el('span', 'memory-mini__label', formatMemoryLabel(memory)),
      memory.quote ? el('span', 'memory-mini__quote', `“${memory.quote.slice(0, 44)}”`) : ''
    );
    dom.memoryPreview.append(item);
  }
}

function renderComposerState() {
  dom.sendBtn.disabled = state.generating;
  dom.composer.classList.toggle('is-busy', state.generating);
  dom.composerHint.textContent = state.generating
    ? '它正在想…'
    : 'Enter 发送 · Shift + Enter 换行';
  renderMode();
}

function renderMode() {
  dom.modeLabel.replaceChildren();
  const dot = el('i');
  dot.setAttribute('aria-hidden', 'true');
  dom.modeLabel.append(dot, document.createTextNode(state.llm.enabled ? '云端心智' : '本地心智'));
  dom.modeLabel.classList.toggle('is-cloud', state.llm.enabled);
  dom.modeLabel.title = state.llm.enabled
    ? `云端心智 · ${state.llm.model || '已配置'}`
    : '本地心智 · 完全离线可用';
}

function setGenerating(value) {
  state.generating = Boolean(value);
  renderComposerState();
}

function focusComposer() {
  if (!window.matchMedia('(min-width: 861px)').matches) return;
  try {
    dom.messageInput.focus({ preventScroll: true });
  } catch {
    dom.messageInput.focus();
  }
}

function openSetup(seedText = '') {
  if (state.generating) {
    showToast('等它说完这一句，再开新话题。');
    return;
  }
  if (state.view === 'setup') return;
  const returnView = state.view === 'chat' ? 'chat' : 'landing';
  const returnFocus = state.layerOpen ? null : document.activeElement;
  if (state.layerOpen) closeTransient({ restoreFocus: false });
  state.setupReturnFocus = returnFocus;
  state.setup = {
    seedText: String(seedText ?? '').trim().slice(0, 2000),
    returnView,
    step: 1,
    genderChoice: null,
    gender: null
  };
  state.view = 'setup';
  dom.topicInput.value = '';
  renderView();
  focusSetupStep();
}

function closeSetup() {
  if (!state.setup) return;
  const { returnView, seedText } = state.setup;
  const focusTarget = state.setupReturnFocus;
  state.setup = null;
  state.view = returnView;
  if (returnView === 'landing' && seedText) dom.topicInput.value = seedText;
  renderView();
  requestAnimationFrame(() => {
    if (
      focusTarget &&
      document.contains(focusTarget) &&
      focusTarget.getClientRects().length > 0
    ) {
      focusTarget.focus();
      return;
    }
    if (returnView === 'landing') {
      dom.topicInput.focus();
    } else {
      dom.newTopicHeader.focus();
    }
  });
}

function buildGenderGrid() {
  dom.setupGenderGrid.replaceChildren();
  GENDER_CHOICES.forEach((choice, index) => {
    const card = button('gender-card');
    card.dataset.gender = choice.id;
    const top = el('div', 'gender-card__top');
    top.append(
      el('span', 'gender-card__index', String(index + 1).padStart(2, '0')),
      el('span', 'gender-card__label', choice.label)
    );
    card.append(top, el('span', 'gender-card__hint', choice.hint));
    card.addEventListener('click', () => chooseGender(choice.id));
    dom.setupGenderGrid.append(card);
  });
}

function chooseGender(choice) {
  if (!state.setup) return;
  state.setup.genderChoice = choice;
  state.setup.gender = resolveGender(choice, secureRandom);
  state.setup.step = 2;
  renderSetup();
  focusSetupStep();
}

function backToGender() {
  if (!state.setup) return;
  state.setup.step = 1;
  renderSetup();
  focusSetupStep();
}

function focusSetupStep() {
  requestAnimationFrame(() => {
    if (!state.setup) return;
    if (state.setup.step === 1) {
      dom.setupGenderGrid.querySelector('button')?.focus();
      return;
    }
    (dom.setupNameGrid.querySelector('button') ?? dom.setupNoPersona)?.focus();
  });
}

function renderSetup() {
  const setup = state.setup;
  if (!setup) return;
  dom.setupGenderStep.hidden = setup.step !== 1;
  dom.setupPersonaStep.hidden = setup.step !== 2;
  dom.setupStepLabel.textContent = setup.step === 1 ? '01 / 02' : '02 / 02';
  if (setup.step === 1) {
    if (dom.setupGenderGrid.children.length === 0) buildGenderGrid();
    return;
  }

  const pool = charactersForGender(setup.gender);
  const context =
    setup.genderChoice === 'random'
      ? `随机结果：${genderLabel(setup.gender)} · ${pool.length} 位可选`
      : setup.gender === 'none'
        ? `不限定性别 · ${pool.length} 位可选`
        : `${genderLabel(setup.gender)} · ${pool.length} 位可选`;
  dom.setupGenderContext.textContent = context;
  buildNameGrid(pool);
}

function buildNameGrid(pool) {
  dom.setupNameGrid.replaceChildren();
  for (const character of pool) {
    const profile = personaById(character.id);
    const tile = button('name-tile', character.name);
    tile.dataset.characterId = character.id;
    tile.setAttribute(
      'aria-label',
      `${character.name}。点击选择，长按或按 I 查看人物简介`
    );
    tile.addEventListener('click', () => {
      const pressedAt = Number(tile.dataset.longPressedAt || 0);
      if (Date.now() - pressedAt < 750) return;
      chooseCharacter(character.id);
    });
    tile.addEventListener('keydown', (event) => {
      if (event.key === 'i' || event.key === 'I' || event.key === '?') {
        event.preventDefault();
        openCharacterBio(profile, {
          onChoose: () => chooseCharacter(character.id)
        });
      }
    });
    bindLongPress(tile, () =>
      openCharacterBio(profile, {
        onChoose: () => chooseCharacter(character.id)
      })
    );
    dom.setupNameGrid.append(tile);
  }
}

function bindLongPress(node, handler) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const begin = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startX = event.clientX ?? 0;
    startY = event.clientY ?? 0;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      node.dataset.longPressedAt = String(Date.now());
      state.ignoreOverlayUntil = Date.now() + 1200;
      if (typeof navigator.vibrate === 'function') navigator.vibrate(12);
      handler();
    }, 550);
  };
  node.addEventListener('pointerdown', begin);
  node.addEventListener('pointermove', (event) => {
    if (!timer) return;
    const dx = (event.clientX ?? 0) - startX;
    const dy = (event.clientY ?? 0) - startY;
    if (Math.hypot(dx, dy) > 8) cancel();
  });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', (event) => event.preventDefault());
}

function chooseCharacter(characterId) {
  if (!state.setup) return;
  const character = personaById(characterId);
  if (!character?.isCharacter) return;
  beginTopic({
    seedText: state.setup.seedText,
    personaId: character.id,
    gender: character.gender,
    genderChoice: state.setup.genderChoice,
    selectionMode: 'specific'
  });
}

function chooseRandomPersona() {
  if (!state.setup) return;
  const character = selectCharacter({
    gender: state.setup.gender,
    random: secureRandom
  });
  if (!character) return;
  beginTopic({
    seedText: state.setup.seedText,
    personaId: character.id,
    gender: character.gender,
    genderChoice: state.setup.genderChoice,
    selectionMode: 'random'
  });
}

function chooseNoPersona() {
  if (!state.setup) return;
  beginTopic({
    seedText: state.setup.seedText,
    personaId: 'none',
    gender: state.setup.gender || 'none',
    genderChoice: state.setup.genderChoice,
    selectionMode: 'none'
  });
}

function beginTopic({
  seedText = '',
  personaId,
  gender = 'none',
  genderChoice = null,
  selectionMode = 'specific'
} = {}) {
  if (state.generating) {
    showToast('等它说完这一句，再开新话题。');
    return;
  }
  if (!personaById(personaId)) personaId = 'none';
  const seed = String(seedText ?? '').trim().slice(0, 2000);
  const topic = createTopic({
    title: seed ? titleFromText(seed) : '未命名话题',
    personaId,
    gender,
    genderChoice,
    selectionMode
  });

  state.data.topics.unshift(topic);
  state.data.activeTopicId = topic.id;
  state.activeTopicId = topic.id;
  state.view = 'chat';
  state.setup = null;
  dom.topicInput.value = '';

  if (seed) {
    appendMessage(topic, { role: 'user', text: seed });
  }

  setGenerating(true);
  renderView();
  if (seed) captureUserSignals(seed, topic);
  saveNow();
  void playOpening(topic, seed);
}

async function playOpening(topic, seed) {
  const persona = profileForTopic(topic);
  const mode =
    topic.selectionMode === 'specific'
      ? '指定'
      : topic.selectionMode === 'random'
        ? `${personaPercent(persona)} · 随机`
        : persona.isNone
          ? genderLabel(topic.gender)
          : personaPercent(persona);
  const divider = persona.isNone
    ? `本次相遇 · 无人设 · ${genderLabel(topic.gender)}`
    : persona.isCharacter
      ? `本次相遇 · ${persona.name} · ${persona.archetypeName} · ${mode}`
      : `本次相遇 · ${persona.name} · ${mode}`;

  await wait(420);
  addSystemMessage(topic, divider);
  await wait(300);

  // 无人设保留固定开场白；选定角色后由角色本人自然开场，不使用通用问候。
  if (persona.isNone) {
    addAssistantMessage(topic, OPENING_LINE, 'greeting');
    await wait(520);

    if (seed) {
      await generateReply(topic, seed, {
        isOpening: true,
        locked: true,
        openingGreeting: true,
        openingMode: 'topic',
        kind: 'reply'
      });
      return;
    }

    addAssistantMessage(topic, persona.followUp, 'followup');
    setGenerating(false);
    renderSuggestionsForActive();
    saveNow();
    focusComposer();
    return;
  }

  const localText = composeCharacterOpening(persona, {
    text: seed,
    history: topic.messages,
    memories: state.data.memories,
    traits: state.data.traits,
    random: secureRandom
  });

  await generateReply(topic, seed, {
    isOpening: true,
    locked: true,
    openingGreeting: false,
    openingMode: seed ? 'topic' : 'empty',
    kind: 'opening',
    localText
  });

  if (!seed) {
    renderSuggestionsForActive();
    maybeScroll();
  }
}

function renderSuggestionsForActive() {
  const topic = getActiveTopic();
  if (!topic) return;
  appendSuggestions(topic);
  maybeScroll();
}

function addSystemMessage(topic, text) {
  const message = appendMessage(topic, { role: 'system', text, kind: 'divider' });
  appendMessageNode(topic, message, true);
  renderTopics();
  saveNow();
  return message;
}

function addAssistantMessage(topic, text, kind = 'reply') {
  const message = appendMessage(topic, { role: 'assistant', text, kind });
  appendMessageNode(topic, message, true);
  renderTopics();
  renderInsights(topic);
  saveNow();
  return message;
}

function addUserMessage(topic, text) {
  const message = appendMessage(topic, { role: 'user', text });
  if (countUserMessages(topic) === 1 && topic.title === '未命名话题') {
    topic.title = titleFromText(text);
  }
  appendMessageNode(topic, message, true);
  renderTopics();
  renderHeader(topic);
  saveNow();
  return message;
}

function captureUserSignals(text, topic) {
  const candidates = extractMemories(text, { quote: text });
  if (candidates.length > 0) {
    const result = mergeMemories(state.data.memories, candidates, {
      topicId: topic.id,
      now: Date.now()
    });
    state.data.memories = result.memories;
    if (result.added.length > 0) {
      showMemoryToast(result.added);
      renderMemoryCounts();
    }
  }

  const traitResult = inferTraits(state.data.traits, text);
  state.data.traits = traitResult.traits;
  renderInsights(topic);
  saveNow();
}

function captureModelMemories(items, userText, topic) {
  const candidates = (Array.isArray(items) ? items : [])
    .map((item) => sanitizeMemoryCandidate(item, userText))
    .filter(Boolean);
  if (candidates.length === 0) return;
  const result = mergeMemories(state.data.memories, candidates, {
    topicId: topic.id,
    now: Date.now(),
    quote: userText
  });
  state.data.memories = result.memories;
  if (result.added.length > 0) {
    showMemoryToast(result.added);
  }
  renderMemoryCounts();
  renderInsights(topic);
  saveNow();
}

function showMemoryToast(memories) {
  if (!memories.length) return;
  if (memories.length === 1) {
    showToast(`已记住 · ${formatMemoryLabel(memories[0])}`);
  } else {
    const labels = memories
      .slice(0, 2)
      .map((memory) => formatMemoryLabel(memory))
      .join(' / ');
    showToast(`已记住 ${memories.length} 条线索 · ${labels}`);
  }
}

function renderMemoryCounts() {
  dom.memoryCount.textContent = String(state.data.memories.length);
  dom.headerMemoryCount.textContent = String(state.data.memories.length);
  const topic = getActiveTopic();
  if (topic) dom.chatSubtitle.textContent = `跨话题记忆 · ${state.data.memories.length} 条`;
}

function buildChatPayload(topic, options = {}) {
  const persona = profileForTopic(topic);
  const messages = topic.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-16)
    .map((message) => ({ role: message.role, text: message.text }));
  const memories = state.data.memories.slice(-80).map((memory) => ({
    category: memory.category,
    key: memory.key,
    value: memory.value,
    quote: memory.quote,
    confidence: memory.confidence
  }));
  return {
    personaId: persona.id,
    gender: persona.isCharacter ? persona.gender : topic.gender,
    selectionMode: topic.selectionMode,
    messages,
    memories,
    traits: state.data.traits,
    habitNotes: deriveHabits(state.data.traits),
    isOpening: Boolean(options.isOpening),
    openingGreeting: Boolean(options.openingGreeting),
    openingMode: options.openingMode === 'empty' ? 'empty' : 'topic'
  };
}

async function requestModel(topic, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32_000);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildChatPayload(topic, options)),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function notifyLlmFallback() {
  const now = Date.now();
  if (now - state.lastLlmErrorAt < 60_000) return;
  state.lastLlmErrorAt = now;
  showToast('云端心智暂时离线，已用本地心智回应。');
}

async function generateReply(topic, userText, options = {}) {
  const {
    isOpening = false,
    locked = false,
    openingGreeting = false,
    openingMode = 'topic',
    kind = 'reply',
    localText = ''
  } = options;
  if (!locked) setGenerating(true);
  const typing = showTyping();
  let reply = '';
  let fromModel = false;

  try {
    if (state.llm.enabled) {
      try {
        const result = await requestModel(topic, {
          isOpening,
          openingGreeting,
          openingMode
        });
        if (result?.mode === 'llm' && typeof result.reply === 'string' && result.reply.trim()) {
          reply = result.reply.trim();
          fromModel = true;
          captureModelMemories(result.memories, userText, topic);
        }
      } catch {
        notifyLlmFallback();
      }
    }

    if (!reply) {
      await wait(520 + secureRandom() * 520);
      reply =
        localText ||
        composeLocalReply({
          persona: profileForTopic(topic),
          text: userText,
          history: topic.messages,
          memories: state.data.memories,
          traits: state.data.traits,
          random: secureRandom
        });
    }

    removeTyping(typing);
    addAssistantMessage(topic, reply, fromModel ? (kind === 'opening' ? 'opening' : 'reply-llm') : kind);
    renderInsights(topic);
  } catch (error) {
    console.error('[echo] reply failed', error);
    removeTyping(typing);
    try {
      addAssistantMessage(
        topic,
        '我在这里。刚才那句话没接稳，你愿意再说一次吗？',
        'reply'
      );
    } catch {
      // 播放失败时至少解锁输入，不让页面卡死。
    }
  } finally {
    removeTyping(typing);
    setGenerating(false);
    saveNow();
    if (state.activeTopicId === topic.id) {
      focusComposer();
      maybeScroll();
    }
  }
}

function sendMessageText(text) {
  const value = String(text ?? '').trim();
  if (!value) return;
  if (state.generating) {
    showToast('等它说完这一句。');
    return;
  }
  const topic = getActiveTopic();
  if (!topic) return;
  dom.messageInput.value = '';
  autoGrow();
  addUserMessage(topic, value);
  captureUserSignals(value, topic);
  setGenerating(true);
  void generateReply(topic, value, { locked: true });
}

function sendCurrentMessage() {
  sendMessageText(dom.messageInput.value);
}

function switchTopic(topicId) {
  if (state.generating) {
    showToast('等它说完这一句，再切换话题。');
    return;
  }
  if (!topicId || topicId === state.activeTopicId) {
    closeTransient();
    return;
  }
  const topic = findTopic(state.data, topicId);
  if (!topic) return;
  state.activeTopicId = topicId;
  state.data.activeTopicId = topicId;
  state.view = 'chat';
  saveNow();
  closeTransient({ restoreFocus: false });
  renderView();
}

function showLanding() {
  if (state.generating) {
    showToast('等它说完这一句，再回首页。');
    return;
  }
  state.view = 'landing';
  renderView();
}

function showActiveChat() {
  const topic = getActiveTopic() ?? state.data.topics[0];
  if (!topic) return;
  state.activeTopicId = topic.id;
  state.data.activeTopicId = topic.id;
  state.view = 'chat';
  saveNow();
  closeTransient({ restoreFocus: false });
  renderView();
}

function deleteTopic(topicId) {
  const topic = findTopic(state.data, topicId);
  if (!topic) return;
  openConfirm({
    title: '删除这段对话？',
    message: '对话原文会被删除，但它在记忆档案里留下的线索不会消失。',
    confirmLabel: '删除对话',
    danger: true,
    onConfirm: () => {
      state.data.topics = state.data.topics.filter((item) => item.id !== topicId);
      if (state.activeTopicId === topicId) {
        const next = state.data.topics[0] ?? null;
        state.activeTopicId = next?.id ?? null;
        state.data.activeTopicId = state.activeTopicId;
        state.view = next ? 'chat' : 'landing';
      }
      saveNow();
      renderView();
      showToast('对话已删除，记忆还在。');
    }
  });
}

function exportAll() {
  const payload = exportPayload(state.data);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const anchor = el('a');
  anchor.href = url;
  anchor.download = `echo-data-${todayStamp()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
  showToast('已导出全部对话与记忆。');
}

function showToast(text) {
  const toast = el('div', 'toast', text);
  dom.toastRoot.append(toast);
  requestAnimationFrame(() => toast.classList.add('is-in'));
  setTimeout(() => {
    toast.classList.remove('is-in');
    setTimeout(() => toast.remove(), 220);
  }, 2800);
  while (dom.toastRoot.children.length > 3) {
    dom.toastRoot.firstElementChild?.remove();
  }
}

function rememberFocus() {
  if (!state.layerOpen) state.lastFocus = document.activeElement;
}

function closeTransient(options = {}) {
  const shouldRestore = options.restoreFocus !== false;
  dom.drawer.classList.remove('is-open');
  dom.drawer.hidden = true;
  dom.drawer.replaceChildren();
  dom.modalRoot.hidden = true;
  dom.modalRoot.replaceChildren();
  dom.overlay.hidden = true;
  document.body.classList.remove('layer-open');
  dom.workspace.classList.remove('is-topics-open', 'is-insights-open');
  state.layerOpen = false;
  if (shouldRestore) {
    const target = state.lastFocus;
    state.lastFocus = null;
    if (target && document.contains(target) && typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    }
  }
}

function openDrawerNode(node) {
  rememberFocus();
  closeTransient({ restoreFocus: false });
  state.layerOpen = true;
  dom.drawer.replaceChildren(node);
  dom.drawer.hidden = false;
  dom.overlay.hidden = false;
  document.body.classList.add('layer-open');
  requestAnimationFrame(() => dom.drawer.classList.add('is-open'));
  setTimeout(() => {
    dom.drawer.querySelector('[data-close]')?.focus();
  }, 30);
}

function openModalNode(node) {
  rememberFocus();
  closeTransient({ restoreFocus: false });
  state.layerOpen = true;
  dom.modalRoot.replaceChildren(node);
  dom.modalRoot.hidden = false;
  dom.overlay.hidden = false;
  document.body.classList.add('layer-open');
  requestAnimationFrame(() => node.classList.add('is-open'));
  setTimeout(() => {
    const target =
      node.querySelector('[data-autofocus]') ??
      node.querySelector('button:not([disabled])');
    target?.focus();
  }, 30);
}

function activeLayer() {
  if (!dom.modalRoot.hidden) return dom.modalRoot.querySelector('.modal');
  if (!dom.drawer.hidden) return dom.drawer;
  if (dom.workspace.classList.contains('is-topics-open')) return dom.topicsPanel;
  if (dom.workspace.classList.contains('is-insights-open')) return dom.insightsPanel;
  return null;
}

function trapFocus(event) {
  if (event.key !== 'Tab' || !state.layerOpen) return;
  const layer = activeLayer();
  if (!layer) return;
  const focusable = [
    ...layer.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ].filter((node) => node.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!layer.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openMobilePanel(which) {
  rememberFocus();
  closeTransient({ restoreFocus: false });
  state.layerOpen = true;
  dom.workspace.classList.add(which === 'topics' ? 'is-topics-open' : 'is-insights-open');
  dom.overlay.hidden = false;
  document.body.classList.add('layer-open');
  setTimeout(() => {
    (which === 'topics' ? dom.topicsClose : dom.insightsClose)?.focus();
  }, 30);
}

function modalShell(title, subtitle) {
  const modal = el('div', 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'modal-title');
  const head = el('div', 'modal__head');
  const copy = el('div');
  copy.append(
    el('p', 'eyebrow eyebrow--small', subtitle || 'ECHO'),
    el('h2', 'modal__title', title)
  );
  const close = button('icon-btn', '×', '关闭');
  close.dataset.close = 'true';
  head.append(copy, close);
  modal.append(head);
  return modal;
}

function closeButtonHandler(modal) {
  modal.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', () => closeTransient());
  });
}

function openConfirm(options) {
  const modal = modalShell(options.title, '确认');
  modal.append(el('p', 'modal__copy', options.message));
  const actions = el('div', 'modal__actions');
  const cancel = button('ghost-btn', '再想想');
  cancel.dataset.autofocus = 'true';
  cancel.addEventListener('click', () => closeTransient());
  const confirm = button(options.danger ? 'danger-btn' : 'primary-btn', options.confirmLabel || '确认');
  confirm.addEventListener('click', () => {
    closeTransient({ restoreFocus: false });
    options.onConfirm?.();
  });
  actions.append(cancel, confirm);
  modal.append(actions);
  closeButtonHandler(modal);
  openModalNode(modal);
}

function openPersonaInfo() {
  const modal = modalShell('四种性格，十六种相遇', 'PERSONA');
  modal.append(
    el(
      'p',
      'modal__copy',
      '每个新话题先选性别，再从名字里选一位角色；也可以无人设或随机。随机时会按 30 / 15 / 25 / 30 抽取人格类型。'
    )
  );

  const bar = el('div', 'prob-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const persona of PERSONAS) {
    const segment = el('span', 'prob-bar__segment');
    segment.style.width = `${persona.probability * 100}%`;
    segment.title = `${persona.name} ${personaPercent(persona)}`;
    bar.append(segment);
  }

  const grid = el('div', 'persona-info-grid');
  const current = getActiveTopic() ? getActivePersona() : null;
  const currentArchetypeId = current?.archetypeId ?? null;
  if (current?.isNone) {
    modal.append(
      el('p', 'modal__copy', '本轮选择的是无人设，所以没有高亮的人格卡。')
    );
  }
  for (const group of characterNamesByArchetype()) {
    const card = el('article', 'persona-info');
    const isCurrent = currentArchetypeId === group.id;
    if (isCurrent) card.classList.add('is-current');
    const head = el('div', 'persona-info__head');
    head.append(
      el('span', 'persona-info__sigil', group.sigil),
      el('span', 'persona-info__name', group.name),
      el(
        'span',
        'persona-info__prob',
        isCurrent ? `${personaPercent(group)} · 本轮` : personaPercent(group)
      )
    );
    card.append(
      head,
      el('p', 'persona-info__tagline', group.tagline),
      el('p', 'persona-info__preview', `“${group.preview}”`),
      el(
        'p',
        'persona-info__names',
        `角色：${group.characters.map((character) => character.name).join(' / ')}`
      )
    );
    grid.append(card);
  }

  const actions = el('div', 'modal__actions');
  const close = button('ghost-btn', '知道了');
  close.addEventListener('click', () => closeTransient());
  const choose = button('primary-btn', '去选人设');
  choose.disabled = state.generating;
  choose.addEventListener('click', () => {
    closeTransient();
    openSetup();
  });
  actions.append(close, choose);
  modal.append(bar, grid, actions);
  closeButtonHandler(modal);
  openModalNode(modal);
}

function openCharacterBio(persona, options = {}) {
  if (!persona?.isCharacter) return;
  const modal = modalShell(persona.name, persona.archetypeName || 'PERSONA');
  modal.append(
    el(
      'p',
      'bio-meta',
      `${genderLabel(persona.gender)} · ${persona.age}岁 · ${persona.occupation}`
    ),
    el('p', 'bio-signature', `“${persona.signature}”`),
    el('p', 'bio-text', persona.bio)
  );
  const actions = el('div', 'modal__actions');
  const close = button('ghost-btn', '知道了');
  close.addEventListener('click', () => closeTransient());
  actions.append(close);
  if (typeof options.onChoose === 'function') {
    const choose = button('primary-btn', '就选 TA');
    choose.addEventListener('click', () => {
      closeTransient({ restoreFocus: false });
      options.onChoose();
    });
    actions.append(choose);
  }
  modal.append(actions);
  closeButtonHandler(modal);
  openModalNode(modal);
}

function openNoPersonaInfo() {
  const modal = modalShell('无人设', 'ECHO');
  modal.append(
    el(
      'p',
      'modal__copy',
      '这一轮不套用固定角色。回声会保留自己的声音，按你的表达方式调整节奏，不假装成某个具体的人。它仍然会记住你，也会继续遵守温柔、诚实和不越界的边界。'
    )
  );
  const actions = el('div', 'modal__actions');
  const close = button('primary-btn', '知道了');
  close.addEventListener('click', () => closeTransient());
  actions.append(close);
  modal.append(actions);
  closeButtonHandler(modal);
  openModalNode(modal);
}

function openMemoryDrawer() {
  const drawer = el('div', 'drawer__inner');
  const head = el('div', 'drawer__head');
  const copy = el('div');
  copy.append(
    el('p', 'eyebrow eyebrow--small', 'MEMORY / 它记得的你'),
    el('h2', 'drawer__title', '记忆档案')
  );
  const close = button('icon-btn', '×', '关闭记忆档案');
  close.dataset.close = 'true';
  head.append(copy, close);

  const memories = [...state.data.memories].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  const stats = el(
    'p',
    'drawer__stats',
    `已完整保存 ${countMessages(state.data)} 条消息 · ${memories.length} 条记忆线索`
  );

  const actions = el('div', 'drawer__actions');
  const exportBtn = button('ghost-btn', '导出全部数据');
  exportBtn.id = 'drawer-export';
  const clearBtn = button('danger-text-btn', '清空记忆');
  clearBtn.id = 'drawer-clear';
  actions.append(exportBtn, clearBtn);

  const body = el('div', 'memory-groups');
  if (memories.length === 0) {
    const empty = el('div', 'drawer__empty');
    empty.append(
      el('p', 'drawer__empty-title', '这里还是空的。'),
      el('p', 'drawer__empty-copy', '你随口说过的名字、喜好、最近在忙的事，都会慢慢出现在这里。')
    );
    body.append(empty);
  } else {
    for (const category of Object.keys(MEMORY_CATEGORIES)) {
      const group = memories.filter((memory) => memory.category === category);
      if (group.length === 0) continue;
      const section = el('section', 'memory-group');
      section.append(
        el('p', 'memory-group__label', `${categoryLabel(category)} · ${group.length}`)
      );
      for (const memory of group) {
        const item = el('div', 'memory-item');
        const main = el('div', 'memory-item__main');
        main.append(
          el('p', 'memory-item__label', formatMemoryLabel(memory)),
          memory.quote
            ? el('p', 'memory-item__quote', `“${memory.quote.slice(0, 100)}”`)
            : ''
        );
        const remove = button('memory-item__remove', '×', `忘记：${formatMemoryLabel(memory)}`);
        remove.dataset.deleteMemory = memory.id;
        item.append(main, remove);
        section.append(item);
      }
      body.append(section);
    }
  }

  const footprint = el(
    'p',
    'drawer__foot',
    '原始对话、结构化记忆与性格画像都只保存在当前浏览器。导出后会得到一个完整 JSON。'
  );

  const transcript = listUserMessages(state.data, { limit: 100 });
  const transcriptDetails = el('details', 'transcript');
  const transcriptSummary = el('summary', 'transcript__summary');
  transcriptSummary.append(
    el('span', 'transcript__label', '原文存档'),
    el('span', 'transcript__count', `${transcript.total} 条你说过的话`)
  );
  transcriptDetails.append(transcriptSummary);
  if (transcript.items.length === 0) {
    transcriptDetails.append(
      el('p', 'transcript__empty', '你还没有说过什么。开口之后，原话会完整出现在这里。')
    );
  } else {
    const transcriptList = el('div', 'transcript__list');
    for (const item of transcript.items) {
      const row = el('article', 'transcript__item');
      const meta = el('div', 'transcript__meta');
      meta.append(
        el('span', 'transcript__topic', item.topicTitle),
        el('time', 'transcript__time', formatTime(item.createdAt))
      );
      row.append(meta, el('p', 'transcript__text', item.text));
      transcriptList.append(row);
    }
    transcriptDetails.append(transcriptList);
    if (transcript.total > transcript.items.length) {
      transcriptDetails.append(
        el(
          'p',
          'transcript__note',
          `这里展示最近 ${transcript.items.length} 条；完整原文已保存在数据中，导出 JSON 会包含全部。`
        )
      );
    }
  }

  drawer.append(head, stats, actions, body, transcriptDetails, footprint);
  closeButtonHandler(drawer);
  openDrawerNode(drawer);
}

function deleteMemory(memoryId) {
  state.data.memories = state.data.memories.filter((memory) => memory.id !== memoryId);
  saveNow();
  renderInsights();
  renderMemoryCounts();
  showToast('已忘记这条线索。');
  openMemoryDrawer();
}

function confirmClearMemories() {
  openConfirm({
    title: '清空所有记忆？',
    message: '会删除全部记忆线索与性格画像。对话原文不会受影响。',
    confirmLabel: '清空记忆',
    danger: true,
    onConfirm: () => {
      state.data.memories = [];
      state.data.traits = { ...DEFAULT_TRAITS };
      saveNow();
      renderInsights();
      renderMemoryCounts();
      showToast('记忆已清空，从零开始。');
    }
  });
}

function confirmClearTopics() {
  openConfirm({
    title: '清空所有对话？',
    message: '会删除所有对话原文与话题列表，但保留记忆档案。',
    confirmLabel: '清空对话',
    danger: true,
    onConfirm: () => {
      state.data.topics = [];
      state.data.activeTopicId = null;
      state.activeTopicId = null;
      state.view = 'landing';
      saveNow();
      renderView();
      showToast('对话已清空，记忆还在。');
    }
  });
}

function openSettings() {
  const modal = modalShell('设置', 'SETTINGS');

  const themeSection = el('section', 'settings-section');
  themeSection.append(el('p', 'settings-label', '主题'));
  const themeRow = el('div', 'segmented');
  for (const [value, label] of [
    ['light', '纸'],
    ['dark', '墨']
  ]) {
    const option = button('segmented__option', label);
    option.dataset.setTheme = value;
    if (state.data.settings.theme === value) option.classList.add('is-active');
    option.addEventListener('click', () => {
      applyTheme(value);
      themeRow.querySelectorAll('[data-set-theme]').forEach((node) => {
        node.classList.toggle('is-active', node.dataset.setTheme === value);
      });
    });
    themeRow.append(option);
  }
  themeSection.append(themeRow);

  const modeSection = el('section', 'settings-section');
  modeSection.append(el('p', 'settings-label', '心智模式'));
  const modeCard = el('div', 'mode-card');
  modeCard.append(
    el(
      'p',
      'mode-card__title',
      state.llm.enabled ? `云端心智 · ${state.llm.model || '已配置'}` : '本地心智 · 离线可用'
    ),
    el(
      'p',
      'mode-card__copy',
      state.llm.enabled
        ? '对话上下文会发送给你配置的模型服务。记忆仍只存在这台设备。'
        : '当前没有配置 API Key，回应由本地人格引擎与日常知识库生成。开放式深度对话建议把 .env.example 复制为 .env 并填入 Key，重启服务器即可切换。'
    )
  );
  modeSection.append(modeCard);

  const dataSection = el('section', 'settings-section');
  dataSection.append(el('p', 'settings-label', '数据'));
  const dataActions = el('div', 'settings-actions');
  const exportBtn = button('ghost-btn', '导出全部数据');
  exportBtn.id = 'settings-export';
  const clearMem = button('ghost-btn', '清空记忆');
  clearMem.id = 'settings-clear-memory';
  const clearTopics = button('danger-text-btn', '清空对话');
  clearTopics.id = 'settings-clear-topics';
  dataActions.append(exportBtn, clearMem, clearTopics);
  dataSection.append(dataActions);

  const about = el('section', 'settings-section settings-section--about');
  about.append(
    el('p', 'settings-label', '关于'),
    el(
      'p',
      'settings-about',
      '回声 ECHO 会记住你，但记忆只属于你。没有账号，没有云端档案。'
    ),
    el('p', 'settings-meta', 'ECHO / 1.3 · 四种性格 · 十六位角色 · 黑白灰极简')
  );

  modal.append(themeSection, modeSection, dataSection, about);
  const actions = el('div', 'modal__actions');
  const close = button('primary-btn', '完成');
  close.addEventListener('click', () => closeTransient());
  actions.append(close);
  modal.append(actions);

  exportBtn.addEventListener('click', exportAll);
  clearMem.addEventListener('click', confirmClearMemories);
  clearTopics.addEventListener('click', confirmClearTopics);
  closeButtonHandler(modal);
  openModalNode(modal);
}

function bindEvents() {
  dom.startForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = dom.topicInput.value.trim();
    if (!text) {
      dom.topicInput.focus();
      showToast('先写下一句话，或点一个示例。');
      return;
    }
    openSetup(text);
  });

  dom.startDefault.addEventListener('click', () => openSetup(''));

  dom.landingPersonas.addEventListener('click', openPersonaInfo);
  dom.personaChip.addEventListener('click', openPersonaInfo);
  dom.landingBrand.addEventListener('click', () => dom.topicInput.focus());
  dom.workspaceBrand.addEventListener('click', showLanding);
  dom.continueBtn.addEventListener('click', showActiveChat);

  dom.setupClose.addEventListener('click', closeSetup);
  dom.setupBack.addEventListener('click', backToGender);
  dom.setupNoPersona.addEventListener('click', chooseNoPersona);
  dom.setupRandomPersona.addEventListener('click', chooseRandomPersona);

  dom.newTopicSidebar.addEventListener('click', () => openSetup());
  dom.newTopicHeader.addEventListener('click', () => openSetup());
  dom.openMemory.addEventListener('click', openMemoryDrawer);
  dom.headerMemory.addEventListener('click', openMemoryDrawer);
  dom.insightsMemory.addEventListener('click', openMemoryDrawer);
  dom.memoryPreview.addEventListener('click', openMemoryDrawer);
  dom.openSettings.addEventListener('click', openSettings);

  dom.openTopics.addEventListener('click', () => openMobilePanel('topics'));
  dom.topicsClose.addEventListener('click', () => closeTransient());
  dom.openInsights.addEventListener('click', () => openMobilePanel('insights'));
  dom.insightsClose.addEventListener('click', () => closeTransient());

  dom.topicList.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-topic]');
    if (deleteButton) {
      event.stopPropagation();
      deleteTopic(deleteButton.dataset.deleteTopic);
      return;
    }
    const openButton = event.target.closest('[data-open-topic]');
    if (openButton) switchTopic(openButton.dataset.openTopic);
  });

  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendCurrentMessage();
  });

  dom.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });

  dom.messageInput.addEventListener('input', autoGrow);

  dom.messageScroll.addEventListener('scroll', updateJumpButton, { passive: true });
  dom.jumpLatest.addEventListener('click', () => scrollToBottom(true));

  dom.overlay.addEventListener('click', () => {
    if (Date.now() < state.ignoreOverlayUntil) return;
    closeTransient();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.layerOpen) {
        closeTransient();
        return;
      }
      if (state.view === 'setup') {
        closeSetup();
        return;
      }
      closeTransient();
      return;
    }
    trapFocus(event);
  });

  dom.themeToggles.forEach((node) => node.addEventListener('click', toggleTheme));

  dom.drawer.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.deleteMemory) {
      deleteMemory(target.dataset.deleteMemory);
      return;
    }
    if (target.id === 'drawer-export') {
      exportAll();
      return;
    }
    if (target.id === 'drawer-clear') {
      confirmClearMemories();
    }
  });

  window.addEventListener('resize', () => {
    if (
      window.innerWidth > 860 &&
      (dom.workspace.classList.contains('is-topics-open') ||
        dom.workspace.classList.contains('is-insights-open'))
    ) {
      closeTransient();
    }
  });

  window.addEventListener('pagehide', saveNow);
}

function autoGrow() {
  const node = dom.messageInput;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
}

async function fetchHealth() {
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('health_failed');
    const data = await response.json();
    state.llm = {
      enabled: Boolean(data?.llm?.enabled),
      model: String(data?.llm?.model ?? '')
    };
  } catch {
    state.llm = { enabled: false, model: '' };
  }
  renderMode();
}

function init() {
  const initial = state.data;
  if (initial.topics.length > 0) {
    const active =
      findTopic(initial, initial.activeTopicId) ?? initial.topics[0];
    state.activeTopicId = active.id;
    initial.activeTopicId = active.id;
    state.view = 'chat';
  } else {
    state.activeTopicId = null;
    state.view = 'landing';
  }

  applyTheme(initial.settings.theme, { persist: false });
  renderStarterChips();
  renderPersonaStrip();
  bindEvents();
  renderView();
  fetchHealth();

  const topic = getActiveTopic();
  if (state.view === 'chat' && topic && topic.messages.length === 0) {
    setGenerating(true);
    renderView();
    void playOpening(topic, '');
  }

  requestAnimationFrame(() => document.body.classList.add('is-ready'));
}

// 保持一个明确的初始化入口，出现异常时不要让页面白屏。
try {
  init();
} catch (error) {
  console.error('[echo] init failed', error);
  document.body.classList.add('is-ready');
  showToast('页面初始化遇到一点问题，刷新试试。');
}
