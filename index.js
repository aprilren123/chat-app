import {
  createApp,
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  inject,
  unref,
} from 'vue';
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

function leftChatsStorageKey(actor) {
  return `nudge-left-chats:${actor || 'anon'}`;
}

const NUDGE_EMOJI_STORAGE_KEY = 'nudge-default-emoji';
const NUDGE_VISIBLE_MS = 24 * 60 * 60 * 1000;
const NUDGE_POP_ANIMATION_MS = 1800;
const NUDGE_POP_OUT_ANIMATION_MS = 260;
const NUDGE_BANNER_URGENT_MS = 60 * 60 * 1000;
const TYPING_SIGNAL_TTL_MS = 3500;
const TYPING_SIGNAL_THROTTLE_MS = 1200;

const JOIN_CHAT_INVITE_LINK_TOOLTIP =
  'In an open conversation, tap Copy invite link beside the title—you can send that chat invite link so others join. Paste a chat invite link here.';

const COPY_CHAT_INVITE_LINK_BUTTON_TOOLTIP =
  'Copies this chat invite link so you can send it for others to join.';

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

function buildResolvedNudgeUrlSet(objects, channel) {
  const resolved = new Set();
  if (!channel || !objects?.length) return resolved;
  const events = objects
    .filter(
      o =>
        o?.channels?.includes(channel) &&
        (o.value?.type === 'Nudge' || o.value?.type === 'NudgeRead')
    )
    .sort((a, b) => (a.value?.published || 0) - (b.value?.published || 0));

  for (const item of events) {
    if (item.value?.type !== 'NudgeRead') continue;
    const pr = item.value?.published ?? 0;
    const readActor = canonicalActorId(item.actor);
    let best = null;
    let bestPub = -1;
    for (const o of events) {
      if (o.value?.type !== 'Nudge') continue;
      const pub = o.value?.published ?? 0;
      if (pub >= pr) continue;
      if (canonicalActorId(o.actor) === readActor) continue;
      if (pub > bestPub) {
        bestPub = pub;
        best = o;
      }
    }
    if (best?.url) resolved.add(best.url);
  }
  return resolved;
}

function normalizeChannelInput(raw) {
  if (!raw) return '';
  let t = raw.trim();
  if (!t) return '';
  const fromChatPath = /\/chat\/([^/?#]+)/.exec(t);
  if (fromChatPath?.[1]) {
    try {
      return decodeURIComponent(fromChatPath[1]);
    } catch {
      return fromChatPath[1];
    }
  }
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

function isMessagePayload(value) {
  const t = value?.type;
  if (t == null) return false;
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (s === 'Message' || s.toLowerCase() === 'message') return true;
  const seg = s.split(/[/:#]/).filter(Boolean).pop() || '';
  return seg === 'Message' || seg.toLowerCase() === 'message';
}

function canonicalActorId(actor) {
  if (actor == null || actor === '') return '';
  return String(actor).trim().split(/[?#]/, 1)[0];
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
  const newChatCardExpanded = ref(true);
  const draftMessage = ref('');

  const defaultNudgeEmoji = ref(loadSavedNudgeEmoji());
  const joinedChats = ref([]);
  const leftChatChannels = ref([]);
  const isJoiningChat = ref(false);
  const listResortNonce = ref(0);
  const channelListOrderTouch = ref(/** @type {Record<string, number>} */ ({}));
  const actorHandleCache = ref(/** @type {Record<string, string>} */ ({}));

  function touchConversationListOrder(channel) {
    if (!channel) return;
    channelListOrderTouch.value = { ...channelListOrderTouch.value, [channel]: Date.now() };
  }

  watch(
    () => session.value?.actor,
    actor => {
      actorHandleCache.value = {};
      if (!actor) {
        joinedChats.value = [];
        leftChatChannels.value = [];
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
      try {
        const rawLeft = localStorage.getItem(leftChatsStorageKey(actor));
        const parsedLeft = rawLeft ? JSON.parse(rawLeft) : [];
        leftChatChannels.value = Array.isArray(parsedLeft)
          ? parsedLeft.filter(c => typeof c === 'string' && String(c).trim())
          : [];
      } catch {
        leftChatChannels.value = [];
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

  function saveLeftChatChannels() {
    const actor = session.value?.actor;
    if (!actor) return;
    try {
      localStorage.setItem(leftChatsStorageKey(actor), JSON.stringify(leftChatChannels.value));
    } catch {
      /* ignore */
    }
  }

  function toggleNewChatCard() {
    newChatCardExpanded.value = !newChatCardExpanded.value;
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

  function getChannelLastActivityMs(objects, channel) {
    if (!channel || !objects?.length) return 0;
    let latest = 0;
    for (const o of objects) {
      if (!o?.channels?.includes(channel)) continue;
      const typ = o.value?.type;
      if (
        !isMessagePayload(o.value) &&
        typ !== 'Nudge' &&
        typ !== 'NudgeRead' &&
        typ !== 'ChatTitle' &&
        typ !== 'ChannelJoin'
      ) {
        continue;
      }
      const p = Number(o.value?.published) || 0;
      if (p > latest) latest = p;
    }
    return latest;
  }

  const chats = computed(() => {
    void listResortNonce.value;
    void leftChatChannels.value;
    const touches = channelListOrderTouch.value;
    const leftHidden = new Set(leftChatChannels.value);
    const owned = chatObjects.value
      .filter(obj => obj.value?.activity === 'Create' && obj.value?.type === 'Chat')
      .filter(obj => !leftHidden.has(obj.value?.channel))
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
      if (leftHidden.has(jc.channel)) continue;
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
      const aRecency = Math.max(
        Number(a.published) || 0,
        getChannelLastActivityMs(objects, chA),
        touches[chA] || 0
      );
      const bRecency = Math.max(
        Number(b.published) || 0,
        getChannelLastActivityMs(objects, chB),
        touches[chB] || 0
      );
      if (bRecency !== aRecency) return bRecency - aRecency;
      const ap = Number(a.published) || 0;
      const bp = Number(b.published) || 0;
      if (bp !== ap) return bp - ap;
      return String(b.channel).localeCompare(String(a.channel));
    });
  });

  const channelIdsForPoll = computed(() => {
    if (!session.value?.actor) return [];
    const left = new Set(leftChatChannels.value);
    const ids = new Set(
      chatObjects.value
        .filter(obj => obj.value?.activity === 'Create' && obj.value?.type === 'Chat')
        .map(obj => obj.value?.channel)
        .filter(Boolean)
    );
    for (const jc of joinedChats.value) {
      const ch = jc.channel;
      if (ch && !left.has(ch)) ids.add(ch);
    }
    return [...ids];
  });

  const { objects: allChannelObjects, isFirstPoll: isLoadingMessages, poll: pollChannelObjects } =
    useGraffitiDiscover(
      () => channelIdsForPoll.value,
      {},
      session,
      true
    );

  const discoverChannelIdsKey = computed(() => {
    const ids = channelIdsForPoll.value;
    if (ids.length === 0) return '';
    return [...ids].sort().join('\0');
  });

  let channelObjectsPollTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
  watch(
    discoverChannelIdsKey,
    key => {
      if (channelObjectsPollTimer) {
        clearInterval(channelObjectsPollTimer);
        channelObjectsPollTimer = null;
      }
      if (!key) return;
      void pollChannelObjects();
      channelObjectsPollTimer = setInterval(() => void pollChannelObjects(), 12000);
    },
    { immediate: true }
  );

  watch(
    allChannelObjects,
    () => {
      listResortNonce.value++;
    },
    { deep: true }
  );

  watch(
    [allChannelObjects, chatObjects, () => session.value?.actor],
    async () => {
      if (!session.value?.actor || typeof graffiti.actorToHandle !== 'function') return;
      const actors = new Set();
      for (const list of [allChannelObjects.value || [], chatObjects.value || []]) {
        for (const o of list) {
          const k = canonicalActorId(o?.actor);
          if (k) actors.add(k);
        }
      }
      for (const actor of actors) {
        if (actorHandleCache.value[actor]) continue;
        try {
          const label = (await graffiti.actorToHandle(actor)).trim();
          if (label) actorHandleCache.value = { ...actorHandleCache.value, [actor]: label };
        } catch {
          /* formatActorFromGraffitiActor */
        }
      }
    },
    { deep: true, immediate: true }
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

      await graffiti.post(
        {
          value: {
            activity: 'Send',
            type: 'ChannelJoin',
            published: Date.now(),
          },
          channels: [chatChannel],
        },
        session.value
      );

      touchConversationListOrder(chatChannel);
      leftChatChannels.value = leftChatChannels.value.filter(c => c !== chatChannel);
      saveLeftChatChannels();
      newChatTitle.value = '';
      await loadChats();
      await pollChannelObjects();
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
      leftChatChannels.value = leftChatChannels.value.filter(c => c !== channel);
      saveLeftChatChannels();
      saveJoinedChats();
      joinChatChannel.value = '';
      await graffiti.post(
        {
          value: {
            activity: 'Send',
            type: 'ChannelJoin',
            published: Date.now(),
          },
          channels: [channel],
        },
        session.value
      );
      await pollChannelObjects();
      touchConversationListOrder(channel);
      await nextTick();
      await router.push('/chat/' + encodeURIComponent(channel));
    } finally {
      isJoiningChat.value = false;
    }
  }

  function resolveChatRowForChannel(channel) {
    const ch = String(channel || '').trim();
    if (!ch || !session.value?.actor) return null;

    const titleByChannel = Object.create(null);
    for (const o of allChannelObjects.value || []) {
      if (o?.value?.type !== 'ChatTitle') continue;
      const p = o.value?.published ?? 0;
      for (const cch of o.channels || []) {
        const prev = titleByChannel[cch];
        if (!prev || p > prev.published) {
          titleByChannel[cch] = { title: o.value?.title, published: p };
        }
      }
    }

    const owned = chatObjects.value.find(
      obj =>
        obj.value?.activity === 'Create' &&
        obj.value?.type === 'Chat' &&
        obj.value?.channel === ch
    );
    if (owned?.value) {
      const base = owned.value;
      const overlay = titleByChannel[ch]?.title;
      return {
        ...base,
        title: overlay || base.title,
        url: owned.url,
        actor: owned.actor,
      };
    }

    const jc = joinedChats.value.find(c => c.channel === ch);
    if (jc) {
      const sharedTitle = titleByChannel[ch]?.title;
      return {
        activity: 'Join',
        type: 'Chat',
        title: sharedTitle || `Joined ${ch.slice(0, 8)}`,
        channel: ch,
        published: jc.published || Date.now(),
        url: `joined:${ch}`,
        actor: session.value.actor,
      };
    }

    return null;
  }

  async function leaveChat(channel) {
    const ch = String(channel || '').trim();
    if (!session.value || !ch) return;
    if (!leftChatChannels.value.includes(ch)) {
      leftChatChannels.value = [...leftChatChannels.value, ch];
      saveLeftChatChannels();
    }
    joinedChats.value = joinedChats.value.filter(c => c.channel !== ch);
    saveJoinedChats();
    listResortNonce.value++;
    await pollChannelObjects();
    const rid = router.currentRoute.value.params.chatId;
    const routeChat = typeof rid === 'string' && rid ? decodeURIComponent(rid) : '';
    if (routeChat === ch) {
      await router.push('/');
    }
  }

  async function renameChatChannel(channel, rawTitle) {
    const ch = String(channel || '').trim();
    const title = String(rawTitle || '').trim();
    if (!session.value || !ch || !title) return;
    if (title.length > 160) return;

    await graffiti.post(
      {
        value: {
          activity: 'Create',
          type: 'ChatTitle',
          title,
          published: Date.now(),
        },
        channels: [ch],
      },
      session.value
    );
    touchConversationListOrder(ch);
    await pollChannelObjects();
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
      await pollChannelObjects();
      touchConversationListOrder(channel);
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
    const resolvedUrls = buildResolvedNudgeUrlSet(objects, channel);
    const mine = objects.filter(
      o =>
        o &&
        o.url &&
        !hidden.has(nudgeObjectKey(o)) &&
        !resolvedUrls.has(o.url) &&
        o.channels?.includes(channel) &&
        o.value?.type === 'Nudge' &&
        canonicalActorId(o.actor) === canonicalActorId(actor)
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
    const resolvedUrls = buildResolvedNudgeUrlSet(objects, channel);
    const list = objects.filter(
      o =>
        o &&
        o.url &&
        !hidden.has(nudgeObjectKey(o)) &&
        !resolvedUrls.has(o.url) &&
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
    const objects = allChannelObjects.value || [];
    const channelSet = new Set(chats.value.map(c => c.channel).filter(Boolean));
    for (const o of objects) {
      for (const ch of o.channels || []) {
        if (ch) channelSet.add(ch);
      }
    }
    const map = Object.create(null);
    for (const ch of channelSet) {
      const n = getLatestVisibleNudge(objects, ch);
      if (n) map[ch] = n;
    }
    return map;
  });

  function peekLatestVisibleNudge(channel) {
    if (!channel) return null;
    return getLatestVisibleNudge(allChannelObjects.value, channel);
  }

  function ownLatestNudgeForChannel(channel) {
    if (!channel) return null;
    return ownLatestNudgeMap.value[channel] ?? null;
  }

  const nudgePendingChannels = ref(new Set());

  function isNudgeBellLockedForMe(channel) {
    if (!session.value?.actor || !channel) return false;
    const n = getLatestVisibleNudge(allChannelObjects.value, channel);
    if (!n) return false;
    return canonicalActorId(n.actor) !== canonicalActorId(session.value.actor);
  }

  function nudgeBellButtonTitle(channel, chatTitle) {
    if (!channel) return 'Send nudge';
    if (isChatNudgePending(channel)) return 'Please wait…';
    if (isNudgeBellLockedForMe(channel)) return 'Dismiss nudge';
    if (peekLatestVisibleNudge(channel)) return 'Undo your nudge';
    return `Nudge ${chatTitle || 'chat'}`;
  }

  function nudgeBellButtonAriaLabel(channel, chatTitle) {
    if (!channel) return 'Send nudge';
    if (isChatNudgePending(channel)) return 'Nudge action in progress';
    if (isNudgeBellLockedForMe(channel)) return "Dismiss someone else's nudge";
    if (peekLatestVisibleNudge(channel)) return 'Undo your nudge';
    return `Send a nudge for ${chatTitle || 'this chat'}`;
  }

  async function readOthersVisibleNudge(channel, item) {
    if (!session.value || !channel) return;
    if (!item || item.value?.type !== 'Nudge') return;
    if (nudgePendingChannels.value.has(channel)) return;
    const latest = getLatestVisibleNudge(allChannelObjects.value, channel);
    if (!latest || latest.url !== item.url) return;
    if (canonicalActorId(latest.actor) === canonicalActorId(session.value.actor)) return;
    if (buildResolvedNudgeUrlSet(allChannelObjects.value, channel).has(item.url)) return;

    nudgePendingChannels.value = new Set(nudgePendingChannels.value).add(channel);
    try {
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
      await pollChannelObjects();
      await new Promise(r => setTimeout(r, 450));
      await pollChannelObjects();
      await nextTick();
      await new Promise(r => {
        requestAnimationFrame(() => requestAnimationFrame(r));
      });
      touchConversationListOrder(channel);
    } finally {
      const done = new Set(nudgePendingChannels.value);
      done.delete(channel);
      nudgePendingChannels.value = done;
    }
  }

  async function readOthersNudgeFromChannel(channel) {
    const latest = getLatestVisibleNudge(allChannelObjects.value, channel);
    if (!latest) return;
    await readOthersVisibleNudge(channel, latest);
  }

  async function toggleNudgeForChannel(channel) {
    if (!session.value || !channel) return;
    if (nudgePendingChannels.value.has(channel)) return;

    const latest = getLatestVisibleNudge(allChannelObjects.value, channel);
    if (latest && canonicalActorId(latest.actor) !== canonicalActorId(session.value.actor)) {
      return;
    }

    nudgePendingChannels.value = new Set(nudgePendingChannels.value).add(channel);

    try {
      if (latest) {
        const latestKey = nudgeObjectKey(latest);
        nudgeDisappearingObjectUrls.value = new Set(nudgeDisappearingObjectUrls.value).add(latestKey);
        await nextTick();
        await new Promise(r => setTimeout(r, NUDGE_POP_OUT_ANIMATION_MS));

        nudgeTombstonedObjectUrls.value = new Set(nudgeTombstonedObjectUrls.value).add(latestKey);
        await nextTick();
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
      touchConversationListOrder(channel);
    } finally {
      const done = new Set(nudgePendingChannels.value);
      done.delete(channel);
      nudgePendingChannels.value = done;
    }
  }

  async function sendNudgeToChat(chat) {
    if (!chat?.channel) return;
    if (isNudgeBellLockedForMe(chat.channel)) {
      await readOthersNudgeFromChannel(chat.channel);
    } else {
      await toggleNudgeForChannel(chat.channel);
    }
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
      touchConversationListOrder(channel);
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
    return (
      canonicalActorId(item.actor) === canonicalActorId(session.value?.actor) && isMessagePayload(item.value)
    );
  }

  function messageRowClass(item) {
    const isNudgeEvent = item.value?.type === 'Nudge' || item.value?.type === 'NudgeRead';
    return {
      own: isOwnMessage(item),
      other: !isOwnMessage(item) && isMessagePayload(item.value),
      nudge: isNudgeEvent,
      join: item.value?.type === 'ChannelJoin',
    };
  }

  function messageBubbleClass(item, opts) {
    const resolvedSet = opts?.resolvedNudgeUrls;
    const ch = opts?.channel;
    const isResolvedRead = item.value?.type === 'NudgeRead';
    const isResolvedNudge =
      item.value?.type === 'Nudge' && resolvedSet instanceof Set && resolvedSet.has(item.url);
    const tapToRead =
      ch && item.value?.type === 'Nudge' ? isOthersNudgeTapToDismiss(item, ch) : false;
    const isNudge = item.value?.type === 'Nudge' || item.value?.type === 'NudgeRead';
    const isJoin = item.value?.type === 'ChannelJoin';
    const isFresh = isFreshNudge(item);
    const isDisappearing = isDisappearingNudge(item);
    return {
      'own-bubble': isOwnMessage(item),
      'other-bubble': !isOwnMessage(item) && isMessagePayload(item.value),
      'nudge-bubble': isNudge,
      'nudge-bubble--resolved': isResolvedRead || isResolvedNudge,
      'nudge-bubble--tap-to-read': tapToRead,
      'nudge-bubble--pop': isFresh && !isResolvedNudge,
      'nudge-bubble--pop-out': isDisappearing,
      'chat-join-bubble': isJoin,
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

  function formatActorFromGraffitiActor(actor) {
    const s = canonicalActorId(actor);
    if (!s) return 'Someone';
    const m = s.match(/([^/?#]+?)(\.graffiti\.actor|\.grafitti\.actor)/i);
    if (m) {
      const part = m[1].split('/').pop() || m[1];
      const label = part.replace(/^@+/, '').replace(/\.+$/, '').trim();
      if (label) return label;
    }
    if (s.includes('/')) {
      const last = s.split('/').filter(Boolean).pop() || '';
      const label = last.replace(/^@+/, '').slice(0, 48);
      if (label) return label;
    }
    return s.length <= 48 ? s : `${s.slice(0, 12)}…`;
  }

  function displayActor(actor) {
    const key = canonicalActorId(actor);
    if (key && key === canonicalActorId(session.value?.actor)) return 'You';
    return actorHandleCache.value[key] || formatActorFromGraffitiActor(actor);
  }

  function displayJoinName(actor) {
    return actorHandleCache.value[canonicalActorId(actor)] || formatActorFromGraffitiActor(actor);
  }

  function isOwnActor(actor) {
    return canonicalActorId(actor) === canonicalActorId(session.value?.actor);
  }

  function isOthersNudgeTapToDismiss(item, channel) {
    if (!channel || !item || item.value?.type !== 'Nudge') return false;
    if (isOwnActor(item.actor)) return false;
    const cur = getLatestVisibleNudge(allChannelObjects.value, channel);
    const resolved = buildResolvedNudgeUrlSet(allChannelObjects.value, channel);
    return !!(cur && cur.url === item.url && !resolved.has(item.url));
  }

  function scrollMessagesToBottom() {
    const box =
      document.querySelector('.chat-route .messages-area') || document.querySelector('.messages-area');
    if (!box) return;
    const run = () => {
      box.scrollTop = box.scrollHeight;
    };
    run();
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }

  const chatFilter = ref(/** @type {'all' | 'nudgesSent' | 'nudgesReceived'} */ ('all'));

  function setChatFilter(/** @type {'all' | 'nudgesSent' | 'nudgesReceived'} */ mode) {
    if (mode === 'all' || mode === 'nudgesSent' || mode === 'nudgesReceived') {
      chatFilter.value = mode;
    }
  }

  const visibleChats = computed(() => {
    void listResortNonce.value;
    const objects = allChannelObjects.value || [];
    const list = chats.value;
    const mode = chatFilter.value;
    if (mode === 'all') return list;

    const me = canonicalActorId(session.value?.actor);
    if (!me) return [];

    const channelKey = c => String(c?.channel ?? '').trim();

    function activeNudgeForChat(c) {
      const ch = channelKey(c);
      if (!ch) return null;
      return getLatestVisibleNudge(objects, ch);
    }

    let filtered;
    if (mode === 'nudgesSent') {
      filtered = list.filter(c => {
        const n = activeNudgeForChat(c);
        return !!(n && canonicalActorId(n.actor) === me);
      });
    } else if (mode === 'nudgesReceived') {
      filtered = list.filter(c => {
        const n = activeNudgeForChat(c);
        return !!(n && canonicalActorId(n.actor) !== me);
      });
    } else {
      filtered = list;
    }

    filtered.sort((a, b) => {
      const pa = activeNudgeForChat(a)?.value?.published ?? 0;
      const pb = activeNudgeForChat(b)?.value?.published ?? 0;
      return pb - pa;
    });

    return filtered;
  });

  return {
    newChatTitle,
    draftMessage,
    chats,
    chatFilter,
    setChatFilter,
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
    newChatCardExpanded,
    toggleNewChatCard,
    isJoiningChat,
    joinChatInviteLinkTooltip: JOIN_CHAT_INVITE_LINK_TOOLTIP,
    copyChatInviteLinkButtonTooltip: COPY_CHAT_INVITE_LINK_BUTTON_TOOLTIP,
    createChat,
    joinChatByChannel,
    leaveChat,
    renameChatChannel,
    resolveChatRowForChannel,
    sendMessageToChannel,
    sendNudgeToChat,
    ownLatestNudgeForChannel,
    peekLatestVisibleNudge,
    isNudgeBellLockedForMe,
    nudgeBellButtonTitle,
    nudgeBellButtonAriaLabel,
    readOthersVisibleNudge,
    readOthersNudgeFromChannel,
    isChatNudgePending,
    formatTime,
    messageRowClass,
    messageBubbleClass,
    isMessagePayload,
    isOthersNudgeTapToDismiss,
    isFreshNudge,
    isDisappearingNudge,
    displayActor,
    displayJoinName,
    isOwnActor,
    ownVisibleNudgeMap,
    ownLatestNudgeMap,
    latestVisibleNudgeMap,
    nudgeTombstonedObjectUrls,
    toggleNudgeForChannel,
    postNudgeWithEmoji,
    postTypingSignal,
    scrollMessagesToBottom,
    pollChannelObjects,
  };
}

function useChatPageState() {
  const s = useNudgeStore();
  const route = useRoute();

  const activeChat = computed(() => {
    const raw = route.params.chatId;
    if (typeof raw !== 'string' || !raw) return null;
    const id = decodeURIComponent(raw);
    return s.resolveChatRowForChannel(id);
  });

  const nowTick = ref(Date.now());

  const inviteLinkJustCopied = ref(false);
  let inviteLinkCopiedTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

  async function copyActiveChatInviteLink() {
    if (!activeChat.value?.channel || typeof window === 'undefined') return;
    const channel = activeChat.value.channel;
    const url = `${window.location.origin}${window.location.pathname}#/chat/${encodeURIComponent(channel)}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      inviteLinkJustCopied.value = true;
      if (inviteLinkCopiedTimer != null) clearTimeout(inviteLinkCopiedTimer);
      inviteLinkCopiedTimer = window.setTimeout(() => {
        inviteLinkJustCopied.value = false;
        inviteLinkCopiedTimer = null;
      }, 2200);
    } catch {
      /* Clipboard unavailable or denied */
    }
  }

  const resolvedNudgeUrls = computed(() =>
    buildResolvedNudgeUrlSet(s.allChannelObjects.value, activeChat.value?.channel || '')
  );

  const chatItems = computed(() => {
    if (!activeChat.value) return [];
    const ch = activeChat.value.channel;
    return s.allChannelObjects.value
      .filter(obj => {
        if (s.nudgeTombstonedObjectUrls.value.has(nudgeObjectKey(obj))) return false;
        if (!obj.channels?.includes(ch)) return false;
        if (isMessagePayload(obj.value)) return true;
        if (obj.value?.type === 'ChannelJoin') return true;
        if (obj.value?.type === 'Nudge') {
          const p = obj.value?.published ?? 0;
          return Date.now() - p <= NUDGE_VISIBLE_MS;
        }
        return false;
      })
      .sort((a, b) => (a.value?.published || 0) - (b.value?.published || 0));
  });

  const chatThreadDisplayItems = computed(() => chatItems.value);

  const nudgeReadTimelineItems = computed(() => {
    if (!activeChat.value) return [];
    const ch = activeChat.value.channel;
    return s.allChannelObjects.value
      .filter(obj => {
        if (s.nudgeTombstonedObjectUrls.value.has(nudgeObjectKey(obj))) return false;
        if (!obj.channels?.includes(ch)) return false;
        return obj.value?.type === 'NudgeRead';
      })
      .sort((a, b) => (a.value?.published || 0) - (b.value?.published || 0));
  });

  const nudgeReadTimelineNewestFirst = computed(() => [...nudgeReadTimelineItems.value].reverse());

  const nudgeReadsPanelExpanded = ref(false);

  function toggleNudgeReadsPanel() {
    nudgeReadsPanelExpanded.value = !nudgeReadsPanelExpanded.value;
  }

  const activeChatVisibleNudge = computed(() => {
    void nowTick.value;
    const ch = activeChat.value?.channel;
    if (!ch) return null;
    return s.peekLatestVisibleNudge(ch);
  });

  const activeChatLatestNudge = computed(() => {
    const ch = activeChat.value?.channel;
    if (!ch) return null;
    return s.ownLatestNudgeMap.value[ch] ?? null;
  });

  const composerNudgeButtonEmoji = computed(() => {
    const ch = activeChat.value?.channel;
    if (ch && s.isNudgeBellLockedForMe(ch)) {
      const latest = s.peekLatestVisibleNudge(ch);
      return latest?.value?.emoji || '🔔';
    }
    const n = activeChatLatestNudge.value;
    if (n?.value?.type === 'Nudge') {
      return n.value.emoji || '🔔';
    }
    return s.defaultNudgeEmoji.value;
  });

  const isComposerEmojiChevronDisabled = computed(() => {
    void nowTick.value;
    const ch = activeChat.value?.channel;
    if (!ch) return true;
    if (s.isChatNudgePending(ch)) return true;
    return !!s.peekLatestVisibleNudge(ch);
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
  function pollMessagesIfTabVisible() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (route.name !== 'chat') return;
    void s.pollChannelObjects();
  }
  onMounted(() => {
    nudgeBannerTimer = setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', pollMessagesIfTabVisible);
    }
    void nextTick(() => {
      requestAnimationFrame(() => s.scrollMessagesToBottom());
    });
  });
  onUnmounted(() => {
    if (nudgeBannerTimer) clearInterval(nudgeBannerTimer);
    if (inviteLinkCopiedTimer != null) clearTimeout(inviteLinkCopiedTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', pollMessagesIfTabVisible);
    }
  });

  const showNudgeEmojiPicker = ref(false);

  const renameChatOpen = ref(false);
  const renameChatDraft = ref('');
  const renameChatSaving = ref(false);

  watch(
    () => {
      const items = chatItems.value;
      const last = items.length ? items[items.length - 1] : null;
      return `${activeChat.value?.channel ?? ''}:${items.length}:${last?.url ?? ''}:${last?.value?.published ?? ''}`;
    },
    async () => {
      await nextTick();
      s.scrollMessagesToBottom();
    }
  );
  watch(
    () => activeChat.value?.channel,
    async () => {
      showNudgeEmojiPicker.value = false;
      renameChatOpen.value = false;
      renameChatDraft.value = '';
      nudgeReadsPanelExpanded.value = false;
      await nextTick();
      s.scrollMessagesToBottom();
    }
  );
  watch(
    () => unref(s.isLoadingMessages),
    async (loading, wasLoading) => {
      if (wasLoading === true && loading === false) {
        await nextTick();
        s.scrollMessagesToBottom();
      }
    }
  );
  watch(
    () => {
      void nowTick.value;
      const ch = activeChat.value?.channel;
      return ch ? s.peekLatestVisibleNudge(ch) : null;
    },
    nudge => {
      if (nudge) showNudgeEmojiPicker.value = false;
    }
  );
  watch(showTypingIndicator, async (typing, wasTyping) => {
    if (typing && !wasTyping) {
      await nextTick();
      s.scrollMessagesToBottom();
    }
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
    void nowTick.value;
    const ch = activeChat.value?.channel;
    if (ch && s.peekLatestVisibleNudge(ch)) return;
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

  async function onMessageBubbleClick(item) {
    if (!item || item.value?.type !== 'Nudge' || !activeChat.value) return;
    await s.readOthersVisibleNudge(activeChat.value.channel, item);
  }

  function openRenameChat() {
    if (!activeChat.value) return;
    renameChatDraft.value = activeChat.value.title || '';
    renameChatOpen.value = true;
  }

  function cancelRenameChat() {
    renameChatOpen.value = false;
  }

  async function submitRenameChat() {
    if (!activeChat.value) return;
    const title = renameChatDraft.value.trim();
    if (!title) return;
    renameChatSaving.value = true;
    try {
      await s.renameChatChannel(activeChat.value.channel, title);
      renameChatOpen.value = false;
    } finally {
      renameChatSaving.value = false;
    }
  }

  async function confirmLeaveChat() {
    if (!activeChat.value) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Leave this conversation? It will disappear from your list on this device. Others are not removed.'
      )
    ) {
      return;
    }
    await s.leaveChat(activeChat.value.channel);
  }

  return {
    activeChat,
    chatItems,
    chatThreadDisplayItems,
    nudgeReadTimelineItems,
    nudgeReadTimelineNewestFirst,
    nudgeReadsPanelExpanded,
    toggleNudgeReadsPanel,
    resolvedNudgeUrls,
    activeChatVisibleNudge,
    activeChatLatestNudge,
    composerNudgeButtonEmoji,
    isComposerEmojiChevronDisabled,
    inviteLinkJustCopied,
    copyActiveChatInviteLink,
    renameChatOpen,
    renameChatDraft,
    renameChatSaving,
    openRenameChat,
    cancelRenameChat,
    submitRenameChat,
    confirmLeaveChat,
    showTypingIndicator,
    showOwnTypingIndicator,
    showOtherTypingIndicator,
    nudgeBannerCountdown,
    showNudgeEmojiPicker,
    openComposerNudgeEmojiPicker,
    closeComposerNudgeEmojiPicker,
    pickOneOffNudgeEmoji,
    onMessageBubbleClick,
    isFreshNudge: s.isFreshNudge,
    isDisappearingNudge: s.isDisappearingNudge,
  };
}

const MainLayout = {
  template: '#layout-template',
  setup() {
    const s = useNudgeStore();
    const router = useRouter();
    const route = useRoute();

    const mobileSidebarOpen = ref(false);

    function openMobileSidebar() {
      mobileSidebarOpen.value = true;
    }

    function closeMobileSidebar() {
      mobileSidebarOpen.value = false;
    }

    watch(
      () => route.fullPath,
      () => {
        mobileSidebarOpen.value = false;
      }
    );

    function onDrawerEscape(e) {
      if (e.key === 'Escape') closeMobileSidebar();
    }

    watch(mobileSidebarOpen, open => {
      if (typeof document === 'undefined') return;
      if (open) document.addEventListener('keydown', onDrawerEscape);
      else document.removeEventListener('keydown', onDrawerEscape);
    });

    onUnmounted(() => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onDrawerEscape);
      }
    });

    function onChatRowClick(e, { navigate, isExactActive }) {
      if (isExactActive) {
        e.preventDefault();
        router.push('/');
        closeMobileSidebar();
        return;
      }
      navigate(e);
      closeMobileSidebar();
    }

    function nudgeEmojiForSidebarRow(chat) {
      if (!chat?.channel) return s.defaultNudgeEmoji.value;
      const n = s.peekLatestVisibleNudge(chat.channel);
      if (n?.value?.type === 'Nudge') {
        return n.value.emoji || '🔔';
      }
      return s.defaultNudgeEmoji.value;
    }

    return {
      ...s,
      mobileSidebarOpen,
      openMobileSidebar,
      closeMobileSidebar,
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
      isMessagePayload,
      async sendMessageForCurrentChat() {
        if (!c.activeChat.value) return;
        await s.sendMessageToChannel(c.activeChat.value.channel);
      },
      async sendNudgeForCurrentChat() {
        if (!c.activeChat.value) return;
        await s.sendNudgeToChat(c.activeChat.value);
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
    incomingDismiss: { type: Boolean, default: false },
    isPending: { type: Boolean, default: false },
    interactionLocked: { type: Boolean, default: false },
    title: { type: String, default: '' },
    ariaLabel: { type: String, default: '' },
  },
  emits: ['toggle'],
  computed: {
    isDisabled() {
      return this.isPending || this.interactionLocked;
    },
    buttonClass() {
      if (this.variant === 'composer') {
        return {
          'ghost-icon-button': true,
          'chat-composer-nudge': true,
          'nudge-bell-button--undo': this.isUndo && !this.incomingDismiss,
          'nudge-bell-button--incoming': this.incomingDismiss,
        };
      }
      return {
        'chat-sidebar-nudge': true,
        'chat-sidebar-nudge--undo': this.isUndo && !this.incomingDismiss,
        'nudge-sidebar-bell--incoming': this.incomingDismiss,
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
