import { createApp, ref, computed, watch, nextTick, onMounted, onUnmounted, provide, inject } from 'vue';
import { createRouter, createWebHashHistory, useRoute, useRouter } from 'vue-router';
import { GraffitiDecentralized } from '@graffiti-garden/implementation-decentralized';
import {
  GraffitiPlugin,
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from '@graffiti-garden/wrapper-vue';

const NUDGE = Symbol('nudge');

function chatDirectoryChannel(actor) {
  return `${actor}/nudge-chats`;
}

function joinedChatsStorageKey(actor) {
  return `nudge-joined-chats:${actor || 'anon'}`;
}

const NUDGE_EMOJI_STORAGE_KEY = 'nudge-default-emoji';
/** Nudges older than this are hidden in the thread */
const NUDGE_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** Newly posted nudges get a one-time pop animation */
const NUDGE_POP_ANIMATION_MS = 1800;
/** Undoing a nudge plays a short pop-out animation */
const NUDGE_POP_OUT_ANIMATION_MS = 260;
/** Banner countdown turns red when this much time or less remains */
const NUDGE_BANNER_URGENT_MS = 60 * 60 * 1000;
/** Typing indicator signal timing */
const TYPING_SIGNAL_TTL_MS = 3500;
const TYPING_SIGNAL_THROTTLE_MS = 1200;

const NUDGE_EMOJI_PRESETS = [
  '🔔', '👋', '✨', '❤️', '🎉', '⚡️', '🔕', '🙌', '💬', '👀', '🤔', '⭐️', '🫶', '💥',
];
function loadSavedNudgeEmoji() {
  try {
    const s = localStorage.getItem(NUDGE_EMOJI_STORAGE_KEY);
    if (s && s.length <= 8) return s;
  } catch {
    /* ignore */
  }
  return '🔔';
}

function formatNudgeTimeRemaining(ms) {
  if (ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if (h >= 1) {
    return `${h}h ${min}m left`;
  }
  if (totalMin >= 1) {
    return `${totalMin}m ${sec}s left`;
  }
  return `${sec}s left`;
}

function nudgeObjectKey(obj) {
  if (!obj?.url) return '';
  return `${obj.url}|${obj.actor || ''}|${obj.value?.published || 0}`;
}

function normalizeChannelInput(raw) {
  if (!raw) return '';
  const t = raw.trim();
  if (!t) return '';
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

function useNudgeStore() {
  return inject(NUDGE);
}

function createNudgeState() {
  const router = useRouter();
  const graffiti = useGraffiti();
  const session = useGraffitiSession();

  const newChatTitle = ref('');
  const joinChatChannel = ref('');
  const draftMessage = ref('');

  const defaultNudgeEmoji = ref(loadSavedNudgeEmoji());
  const joinedChats = ref([]);
  const isJoiningChat = ref(false);

  watch(
    () => session.value?.actor,
    actor => {
      if (!actor) {
        joinedChats.value = [];
        return;
      }
      try {
        const raw = localStorage.getItem(joinedChatsStorageKey(actor));
        const parsed = raw ? JSON.parse(raw) : [];
        joinedChats.value = Array.isArray(parsed)
          ? parsed.filter(c => typeof c?.channel === 'string' && c.channel)
          : [];
      } catch {
        joinedChats.value = [];
      }
    },
    { immediate: true }
  );

  function saveJoinedChats() {
    const actor = session.value?.actor;
    if (!actor) return;
    try {
      localStorage.setItem(joinedChatsStorageKey(actor), JSON.stringify(joinedChats.value));
    } catch {
      /* ignore */
    }
  }

  function setDefaultNudgeEmoji(emoji) {
    defaultNudgeEmoji.value = emoji;
    try {
      localStorage.setItem(NUDGE_EMOJI_STORAGE_KEY, emoji);
    } catch {
      /* ignore */
    }
  }

  const { objects: chatObjects, isFirstPoll: isLoadingChats, poll: loadChats } = useGraffitiDiscover(
    () => (session.value?.actor ? [chatDirectoryChannel(session.value.actor)] : []),
    {},
    session,
    true
  );

  /** Latest activity in a channel (messages / nudges / reads) for recency sorting */
  function getChannelLastActivityMs(objects, channel) {
    if (!channel || !objects?.length) return 0;
    let latest = 0;
    for (const o of objects) {
      if (!o?.channels?.includes(channel)) continue;
      const typ = o.value?.type;
      if (typ !== 'Message' && typ !== 'Nudge' && typ !== 'NudgeRead') continue;
      const p = o.value?.published ?? 0;
      if (p > latest) latest = p;
    }
    return latest;
  }

  const chats = computed(() => {
    const owned = chatObjects.value
      .filter(obj => obj.value?.activity === 'Create' && obj.value?.type === 'Chat')
      .map(obj => ({
        ...obj.value,
        url: obj.url,
        actor: obj.actor,
      }));

    const titleByChannel = Object.create(null);
    for (const o of allChannelObjects.value || []) {
      if (o?.value?.type !== 'ChatTitle') continue;
      const p = o.value?.published ?? 0;
      for (const ch of o.channels || []) {
        const prev = titleByChannel[ch];
        if (!prev || p > prev.published) {
          titleByChannel[ch] = { title: o.value?.title, published: p };
        }
      }
    }

    const byChannel = new Map(owned.map(c => [c.channel, c]));
    for (const [ch, t] of Object.entries(titleByChannel)) {
      const existing = byChannel.get(ch);
      if (existing && t?.title) {
        byChannel.set(ch, { ...existing, title: t.title });
      }
    }
    for (const jc of joinedChats.value) {
      if (byChannel.has(jc.channel)) continue;
      const sharedTitle = titleByChannel[jc.channel]?.title;
      byChannel.set(jc.channel, {
        activity: 'Join',
        type: 'Chat',
        title: sharedTitle || `Joined ${jc.channel.slice(0, 8)}`,
        channel: jc.channel,
        published: jc.published || Date.now(),
        url: `joined:${jc.channel}`,
        actor: session.value?.actor,
      });
    }
    const objects = allChannelObjects.value || [];
    return Array.from(byChannel.values()).sort((a, b) => {
      const chA = a.channel;
      const chB = b.channel;
      const aRecency = Math.max(a.published || 0, getChannelLastActivityMs(objects, chA));
      const bRecency = Math.max(b.published || 0, getChannelLastActivityMs(objects, chB));
      return bRecency - aRecency;
    });
  });

  const { objects: allChannelObjects, isFirstPoll: isLoadingMessages, poll: pollChannelObjects } =
    useGraffitiDiscover(
      () =>
        session.value?.actor
          ? [
              ...new Set([
                ...chatObjects.value
                  .filter(obj => obj.value?.activity === 'Create' && obj.value?.type === 'Chat')
                  .map(obj => obj.value?.channel)
                  .filter(Boolean),
                ...joinedChats.value.map(c => c.channel).filter(Boolean),
              ]),
            ]
          : [],
      {},
      session,
      true
    );

  const isCreatingChat = ref(false);
  const isSendingMessage = ref(false);

  async function createChat() {
    if (!session.value || !newChatTitle.value) return;

    isCreatingChat.value = true;
    try {
      const chatChannel = crypto.randomUUID();

      await graffiti.post(
        {
          value: {
            activity: 'Create',
            type: 'Chat',
            title: newChatTitle.value,
            channel: chatChannel,
            published: Date.now(),
          },
          channels: [chatDirectoryChannel(session.value.actor)],
        },
        session.value
      );

      await graffiti.post(
        {
          value: {
            activity: 'Create',
            type: 'ChatTitle',
            title: newChatTitle.value,
            published: Date.now(),
          },
          channels: [chatChannel],
        },
        session.value
      );

      newChatTitle.value = '';
      await loadChats();
      await router.push('/chat/' + encodeURIComponent(chatChannel));
    } finally {
      isCreatingChat.value = false;
    }
  }

  async function joinChatByChannel() {
    if (!session.value) return;
    const channel = normalizeChannelInput(joinChatChannel.value);
    if (!channel) return;

    isJoiningChat.value = true;
    try {
      const next = [
        ...joinedChats.value.filter(c => c.channel !== channel),
        { channel, published: Date.now() },
      ];
      joinedChats.value = next;
      saveJoinedChats();
      joinChatChannel.value = '';
      await nextTick();
      await router.push('/chat/' + encodeURIComponent(channel));
    } finally {
      isJoiningChat.value = false;
    }
  }

  async function sendMessageToChannel(channel) {
    if (!session.value || !channel || !draftMessage.value) return;

    isSendingMessage.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: 'Send',
            type: 'Message',
            content: draftMessage.value,
            published: Date.now(),
          },
          channels: [channel],
        },
        session.value
      );

      draftMessage.value = '';
      await postTypingSignal(channel, false);
    } finally {
      isSendingMessage.value = false;
    }
  }

  async function postTypingSignal(channel, isTyping) {
    if (!session.value || !channel) return;
    const now = Date.now();
    const prev = typingSignalStateByChannel.value.get(channel);
    if (isTyping && prev?.isTyping && now - prev.sentAt < TYPING_SIGNAL_THROTTLE_MS) return;

    await graffiti.post(
      {
        value: {
          activity: 'Signal',
          type: 'Typing',
          isTyping,
          published: now,
          expiresAt: isTyping ? now + TYPING_SIGNAL_TTL_MS : now,
        },
        channels: [channel],
      },
      session.value
    );

    const next = new Map(typingSignalStateByChannel.value);
    next.set(channel, { isTyping, sentAt: now });
    typingSignalStateByChannel.value = next;
  }

  const nudgeTombstonedObjectUrls = ref(/** @type {Set<string>} */ (new Set()));
  const nudgeDisappearingObjectUrls = ref(/** @type {Set<string>} */ (new Set()));
  const typingSignalStateByChannel = ref(new Map());

  function getOwnLatestNudge(objects, channel, actor) {
    if (!actor || !channel) return null;
    const hidden = nudgeTombstonedObjectUrls.value;
    const mine = objects.filter(
      o =>
        o &&
        o.url &&
        !hidden.has(nudgeObjectKey(o)) &&
        o.channels?.includes(channel) &&
        o.value?.type === 'Nudge' &&
        o.actor === actor
    );
    if (!mine.length) return null;
    mine.sort((a, b) => (b.value?.published || 0) - (a.value?.published || 0));
    return mine[0];
  }

  function getOwnVisibleNudge(objects, channel, actor) {
    const latest = getOwnLatestNudge(objects, channel, actor);
    if (!latest) return null;
    const published = latest.value?.published ?? 0;
    if (Date.now() - published > NUDGE_VISIBLE_MS) return null;
    return latest;
  }

  function getLatestVisibleNudge(objects, channel) {
    if (!channel) return null;
    const hidden = nudgeTombstonedObjectUrls.value;
    const list = objects.filter(
      o =>
        o &&
        o.url &&
        !hidden.has(nudgeObjectKey(o)) &&
        o.channels?.includes(channel) &&
        o.value?.type === 'Nudge'
    );
    if (!list.length) return null;
    list.sort((a, b) => (b.value?.published || 0) - (a.value?.published || 0));
    const latest = list[0];
    const published = latest.value?.published ?? 0;
    if (Date.now() - published > NUDGE_VISIBLE_MS) return null;
    return latest;
  }

  const ownVisibleNudgeMap = computed(() => {
    const actor = session.value?.actor;
    if (!actor) return {};
    const objects = allChannelObjects.value;
    const map = Object.create(null);
    for (const chat of chats.value) {
      const n = getOwnVisibleNudge(objects, chat.channel, actor);
      if (n) map[chat.channel] = n;
    }
    return map;
  });

  const ownLatestNudgeMap = computed(() => {
    const actor = session.value?.actor;
    if (!actor) return {};
    const objects = allChannelObjects.value;
    const map = Object.create(null);
    for (const chat of chats.value) {
      const n = getOwnLatestNudge(objects, chat.channel, actor);
      if (n) map[chat.channel] = n;
    }
    return map;
  });

  const latestVisibleNudgeMap = computed(() => {
    const objects = allChannelObjects.value;
    const map = Object.create(null);
    for (const chat of chats.value) {
      const n = getLatestVisibleNudge(objects, chat.channel);
      if (n) map[chat.channel] = n;
    }
    return map;
  });

  function ownLatestNudgeForChannel(channel) {
    if (!channel) return null;
    return ownLatestNudgeMap.value[channel] ?? null;
  }

  function latestVisibleNudgeForChannel(channel) {
    if (!channel) return null;
    return latestVisibleNudgeMap.value[channel] ?? null;
  }

  const nudgePendingChannels = ref(new Set());

  async function toggleNudgeForChannel(channel) {
    if (!session.value || !channel) return;
    if (nudgePendingChannels.value.has(channel)) return;

    const latest = getLatestVisibleNudge(allChannelObjects.value, channel);

    nudgePendingChannels.value = new Set(nudgePendingChannels.value).add(channel);

    try {
      if (latest) {
        const latestKey = nudgeObjectKey(latest);
        nudgeDisappearingObjectUrls.value = new Set(nudgeDisappearingObjectUrls.value).add(latestKey);
        await nextTick();
        await new Promise(r => setTimeout(r, NUDGE_POP_OUT_ANIMATION_MS));

        nudgeTombstonedObjectUrls.value = new Set(nudgeTombstonedObjectUrls.value).add(latestKey);
        await nextTick();
        if (latest.actor === session.value.actor) {
          try {
            await graffiti.delete(latest.url, session.value);
          } catch (err) {
            const nextT = new Set(nudgeTombstonedObjectUrls.value);
            nextT.delete(latestKey);
            nudgeTombstonedObjectUrls.value = nextT;
            const nextD = new Set(nudgeDisappearingObjectUrls.value);
            nextD.delete(latestKey);
            nudgeDisappearingObjectUrls.value = nextD;
            throw err;
          }
        } else {
          await graffiti.post(
            {
              value: {
                activity: 'Send',
                type: 'NudgeRead',
                emoji: latest.value?.emoji || '🔔',
                published: Date.now(),
              },
              channels: [channel],
            },
            session.value
          );
        }
        const doneDisappearing = new Set(nudgeDisappearingObjectUrls.value);
        doneDisappearing.delete(latestKey);
        nudgeDisappearingObjectUrls.value = doneDisappearing;
      } else {
        await graffiti.post(
          {
            value: {
              activity: 'Send',
              type: 'Nudge',
              emoji: defaultNudgeEmoji.value,
              published: Date.now(),
            },
            channels: [channel],
          },
          session.value
        );
      }
      await pollChannelObjects();
      await nextTick();
      await new Promise(r => {
        requestAnimationFrame(() => requestAnimationFrame(r));
      });
    } finally {
      const done = new Set(nudgePendingChannels.value);
      done.delete(channel);
      nudgePendingChannels.value = done;
    }
  }

  async function sendNudgeToChat(chat) {
    if (!chat?.channel) return;
    await toggleNudgeForChannel(chat.channel);
  }

  async function postNudgeWithEmoji(channel, emoji) {
    if (!session.value || !channel || !emoji) return;
    if (nudgePendingChannels.value.has(channel)) return;

    nudgePendingChannels.value = new Set(nudgePendingChannels.value).add(channel);
    try {
      await graffiti.post(
        {
          value: {
            activity: 'Send',
            type: 'Nudge',
            emoji,
            published: Date.now(),
          },
          channels: [channel],
        },
        session.value
      );
      await pollChannelObjects();
      await nextTick();
      await new Promise(r => {
        requestAnimationFrame(() => requestAnimationFrame(r));
      });
    } finally {
      const done = new Set(nudgePendingChannels.value);
      done.delete(channel);
      nudgePendingChannels.value = done;
    }
  }

  function isChatNudgePending(channel) {
    return nudgePendingChannels.value.has(channel);
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function isOwnMessage(item) {
    return item.actor === session.value?.actor && item.value?.type === 'Message';
  }

  function messageRowClass(item) {
    const isNudgeEvent = item.value?.type === 'Nudge' || item.value?.type === 'NudgeRead';
    return {
      own: isOwnMessage(item),
      other: !isOwnMessage(item) && item.value?.type === 'Message',
      nudge: isNudgeEvent,
    };
  }

  function messageBubbleClass(item) {
    const isNudge = item.value?.type === 'Nudge' || item.value?.type === 'NudgeRead';
    const isFresh = isFreshNudge(item);
    const isDisappearing = isDisappearingNudge(item);
    return {
      'own-bubble': isOwnMessage(item),
      'other-bubble': !isOwnMessage(item) && item.value?.type === 'Message',
      'nudge-bubble': isNudge,
      'nudge-bubble--pop': isFresh,
      'nudge-bubble--pop-out': isDisappearing,
    };
  }

  function isFreshNudge(item) {
    if (!item || item.value?.type !== 'Nudge') return false;
    return Date.now() - (item.value?.published ?? 0) <= NUDGE_POP_ANIMATION_MS;
  }

  function isDisappearingNudge(item) {
    if (!item || item.value?.type !== 'Nudge' || !item.url) return false;
    return nudgeDisappearingObjectUrls.value.has(nudgeObjectKey(item));
  }

  function displayActor(actor) {
    if (actor === session.value?.actor) return 'You';
    return 'Other person';
  }

  function isOwnActor(actor) {
    return actor === session.value?.actor;
  }

  function scrollMessagesToBottom() {
    const box = document.querySelector('.messages-area');
    if (box) box.scrollTop = box.scrollHeight;
  }

  const chatFilter = ref(/** @type {'all' | 'nudges'} */ ('all'));

  const visibleChats = computed(() => {
    const list = chats.value;
    if (chatFilter.value === 'nudges') {
      // Same rule as sidebar/header "nudged" state: latest visible nudge in channel (any actor).
      const map = latestVisibleNudgeMap.value;
      return list.filter(c => Boolean(map[c.channel]));
    }
    return list;
  });

  return {
    newChatTitle,
    draftMessage,
    chats,
    chatFilter,
    visibleChats,
    isLoadingChats,
    isLoadingMessages,
    allChannelObjects,
    isCreatingChat,
    isSendingMessage,
    defaultNudgeEmoji,
    nudgeEmojiPresets: NUDGE_EMOJI_PRESETS,
    setDefaultNudgeEmoji,
    joinChatChannel,
    isJoiningChat,
    createChat,
    joinChatByChannel,
    sendMessageToChannel,
    sendNudgeToChat,
    ownLatestNudgeForChannel,
    latestVisibleNudgeForChannel,
    isChatNudgePending,
    formatTime,
    messageRowClass,
    messageBubbleClass,
    isFreshNudge,
    isDisappearingNudge,
    displayActor,
    isOwnActor,
    ownVisibleNudgeMap,
    ownLatestNudgeMap,
    latestVisibleNudgeMap,
    nudgeTombstonedObjectUrls,
    toggleNudgeForChannel,
    postNudgeWithEmoji,
    postTypingSignal,
    scrollMessagesToBottom,
  };
}

function useChatPageState() {
  const s = useNudgeStore();
  const route = useRoute();

  const activeChat = computed(() => {
    const raw = route.params.chatId;
    if (typeof raw !== 'string' || !raw) return null;
    const id = decodeURIComponent(raw);
    return s.chats.value.find(c => c.channel === id) || null;
  });

  const chatItems = computed(() => {
    if (!activeChat.value) return [];
    const ch = activeChat.value.channel;
    return s.allChannelObjects.value
      .filter(obj => {
        if (s.nudgeTombstonedObjectUrls.value.has(nudgeObjectKey(obj))) return false;
        if (!obj.channels?.includes(ch)) return false;
        if (obj.value?.type === 'Message') return true;
        if (obj.value?.type === 'NudgeRead') return true;
        if (obj.value?.type === 'Nudge') {
          const p = obj.value?.published ?? 0;
          return Date.now() - p <= NUDGE_VISIBLE_MS;
        }
        return false;
      })
      .sort((a, b) => (a.value?.published || 0) - (b.value?.published || 0));
  });

  const activeChatVisibleNudge = computed(() => {
    const ch = activeChat.value?.channel;
    if (!ch) return null;
    return s.latestVisibleNudgeMap.value[ch] ?? null;
  });

  const activeChatLatestNudge = computed(() => {
    const ch = activeChat.value?.channel;
    if (!ch) return null;
    return s.ownLatestNudgeMap.value[ch] ?? null;
  });

  const composerNudgeButtonEmoji = computed(() => {
    const n = activeChatLatestNudge.value;
    if (n?.value?.type === 'Nudge') {
      return n.value.emoji || '🔔';
    }
    return s.defaultNudgeEmoji.value;
  });
  const showTypingIndicator = computed(() => {
    return !!activeChat.value && !!s.draftMessage.value;
  });
  const showOwnTypingIndicator = computed(() => showTypingIndicator.value);
  const showOtherTypingIndicator = computed(() => {
    const ch = activeChat.value?.channel;
    if (!ch) return false;

    const latestByActor = new Map();
    for (const obj of s.allChannelObjects.value) {
      if (!obj?.channels?.includes(ch)) continue;
      if (obj.value?.type !== 'Typing') continue;
      if (s.isOwnActor(obj.actor)) continue;
      const actor = obj.actor || '';
      const published = obj.value?.published ?? 0;
      const prev = latestByActor.get(actor);
      if (!prev || published > (prev.value?.published ?? 0)) {
        latestByActor.set(actor, obj);
      }
    }

    const now = nowTick.value;
    for (const obj of latestByActor.values()) {
      const isTyping = !!obj.value?.isTyping;
      const expiresAt = obj.value?.expiresAt ?? ((obj.value?.published ?? 0) + TYPING_SIGNAL_TTL_MS);
      if (isTyping && expiresAt > now) return true;
    }
    return false;
  });

  const nowTick = ref(Date.now());
  const nudgeBannerCountdown = computed(() => {
    const nudge = activeChatVisibleNudge.value;
    if (!nudge?.value?.published) return null;
    const published = nudge.value.published;
    const endsAt = published + NUDGE_VISIBLE_MS;
    const ms = endsAt - nowTick.value;
    const text = formatNudgeTimeRemaining(ms);
    if (!text) return null;
    return {
      text,
      urgent: ms <= NUDGE_BANNER_URGENT_MS,
    };
  });

  let nudgeBannerTimer = null;
  onMounted(() => {
    nudgeBannerTimer = setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  });
  onUnmounted(() => {
    if (nudgeBannerTimer) clearInterval(nudgeBannerTimer);
  });

  const showNudgeEmojiPicker = ref(false);

  watch(
    chatItems,
    async () => {
      await nextTick();
      s.scrollMessagesToBottom();
    },
    { deep: true }
  );
  watch(
    () => activeChat.value?.channel,
    async () => {
      showNudgeEmojiPicker.value = false;
      await nextTick();
      s.scrollMessagesToBottom();
    }
  );
  watch(showTypingIndicator, async () => {
    await nextTick();
    s.scrollMessagesToBottom();
  });
  watch(
    [() => activeChat.value?.channel, () => s.draftMessage.value],
    async ([channel, draft], [prevChannel]) => {
      if (prevChannel && prevChannel !== channel) {
        await s.postTypingSignal(prevChannel, false);
      }
      if (!channel) return;
      await s.postTypingSignal(channel, !!draft);
    }
  );

  function openComposerNudgeEmojiPicker() {
    showNudgeEmojiPicker.value = true;
  }
  function closeComposerNudgeEmojiPicker() {
    showNudgeEmojiPicker.value = false;
  }
  async function pickOneOffNudgeEmoji(emoji) {
    const ch = activeChat.value;
    if (!ch) return;
    showNudgeEmojiPicker.value = false;
    await s.postNudgeWithEmoji(ch.channel, emoji);
  }

  return {
    activeChat,
    chatItems,
    activeChatVisibleNudge,
    activeChatLatestNudge,
    composerNudgeButtonEmoji,
    showTypingIndicator,
    showOwnTypingIndicator,
    showOtherTypingIndicator,
    nudgeBannerCountdown,
    showNudgeEmojiPicker,
    openComposerNudgeEmojiPicker,
    closeComposerNudgeEmojiPicker,
    pickOneOffNudgeEmoji,
    isFreshNudge: s.isFreshNudge,
    isDisappearingNudge: s.isDisappearingNudge,
  };
}

const MainLayout = {
  template: '#layout-template',
  setup() {
    const s = useNudgeStore();
    const router = useRouter();

    function onChatRowClick(e, { navigate, isExactActive }) {
      if (isExactActive) {
        e.preventDefault();
        router.push('/');
        return;
      }
      navigate(e);
    }

    function nudgeEmojiForSidebarRow(chat) {
      if (!chat?.channel) return s.defaultNudgeEmoji.value;
      const n = s.latestVisibleNudgeForChannel(chat.channel);
      if (n?.value?.type === 'Nudge') {
        return n.value.emoji || '🔔';
      }
      return s.defaultNudgeEmoji.value;
    }

    return {
      ...s,
      onChatRowClick,
      nudgeEmojiForSidebarRow,
    };
  },
};

const HomePage = {
  template: '#home-template',
};

const ChatPage = {
  template: '#chat-template',
  setup() {
    const s = useNudgeStore();
    const c = useChatPageState();
    return {
      ...s,
      ...c,
      async sendMessageForCurrentChat() {
        if (!c.activeChat.value) return;
        await s.sendMessageToChannel(c.activeChat.value.channel);
      },
      async sendNudgeForCurrentChat() {
        if (!c.activeChat.value) return;
        await s.toggleNudgeForChannel(c.activeChat.value.channel);
      },
    };
  },
};

const SettingsPage = {
  template: '#settings-template',
  setup() {
    return {
      ...useNudgeStore(),
    };
  },
};

const NudgeButton = {
  template: '#nudge-button-template',
  props: {
    variant: {
      type: String,
      default: 'sidebar',
      validator: v => v === 'sidebar' || v === 'composer',
    },
    emoji: { type: String, required: true },
    isUndo: { type: Boolean, default: false },
    isPending: { type: Boolean, default: false },
    title: { type: String, default: '' },
    ariaLabel: { type: String, default: '' },
  },
  emits: ['toggle'],
  computed: {
    buttonClass() {
      if (this.variant === 'composer') {
        return {
          'ghost-icon-button': true,
          'chat-composer-nudge': true,
          'nudge-bell-button--undo': this.isUndo,
        };
      }
      return {
        'chat-sidebar-nudge': true,
        'chat-sidebar-nudge--undo': this.isUndo,
      };
    },
  },
  methods: {
    onClick() {
      this.$emit('toggle');
    },
  },
};

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: MainLayout,
      children: [
        { path: '', name: 'home', component: HomePage },
        { path: 'chat/:chatId', name: 'chat', component: ChatPage },
        { path: 'settings', name: 'settings', component: SettingsPage },
      ],
    },
  ],
});

const App = {
  template: '#app-template',
  setup() {
    provide(NUDGE, createNudgeState());
    return {};
  },
};

const app = createApp(App);
app.component('NudgeButton', NudgeButton);
app.use(router);
app.use(GraffitiPlugin, {
  graffiti: new GraffitiDecentralized(),
});
app.mount('#app');
