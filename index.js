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

const NUDGE_EMOJI_STORAGE_KEY = 'nudge-default-emoji';
/** Nudges older than this are hidden in the thread */
const NUDGE_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** Banner countdown turns red when this much time or less remains */
const NUDGE_BANNER_URGENT_MS = 60 * 60 * 1000;

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

function useNudgeStore() {
  return inject(NUDGE);
}

function createNudgeState() {
  const router = useRouter();
  const graffiti = useGraffiti();
  const session = useGraffitiSession();

  const newChatTitle = ref('');
  const draftMessage = ref('');

  const defaultNudgeEmoji = ref(loadSavedNudgeEmoji());

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

  const chats = computed(() => {
    return chatObjects.value
      .filter(obj => obj.value?.activity === 'Create' && obj.value?.type === 'Chat')
      .map(obj => ({
        ...obj.value,
        url: obj.url,
        actor: obj.actor,
      }))
      .sort((a, b) => (a.published || 0) - (b.published || 0));
  });

  const { objects: allChannelObjects, isFirstPoll: isLoadingMessages, poll: pollChannelObjects } =
    useGraffitiDiscover(
      () =>
        session.value?.actor && chats.value.length ? chats.value.map(c => c.channel) : [],
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

      newChatTitle.value = '';
      await loadChats();
      await router.push('/chat/' + encodeURIComponent(chatChannel));
    } finally {
      isCreatingChat.value = false;
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
    } finally {
      isSendingMessage.value = false;
    }
  }

  const nudgeTombstonedObjectUrls = ref(/** @type {Set<string>} */ (new Set()));

  function getOwnLatestNudge(objects, channel, actor) {
    if (!actor || !channel) return null;
    const hidden = nudgeTombstonedObjectUrls.value;
    const mine = objects.filter(
      o =>
        o &&
        o.url &&
        !hidden.has(o.url) &&
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

  function ownLatestNudgeForChannel(channel) {
    if (!channel) return null;
    return ownLatestNudgeMap.value[channel] ?? null;
  }

  const nudgePendingChannels = ref(new Set());

  async function toggleNudgeForChannel(channel) {
    if (!session.value || !channel) return;
    if (nudgePendingChannels.value.has(channel)) return;

    const latest = getOwnLatestNudge(allChannelObjects.value, channel, session.value.actor);

    nudgePendingChannels.value = new Set(nudgePendingChannels.value).add(channel);

    try {
      if (latest) {
        nudgeTombstonedObjectUrls.value = new Set(nudgeTombstonedObjectUrls.value).add(
          latest.url
        );
        await nextTick();
        try {
          await graffiti.delete(latest.url, session.value);
        } catch (err) {
          const nextT = new Set(nudgeTombstonedObjectUrls.value);
          nextT.delete(latest.url);
          nudgeTombstonedObjectUrls.value = nextT;
          throw err;
        }
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
    return {
      own: isOwnMessage(item),
      other: !isOwnMessage(item) && item.value?.type === 'Message',
      nudge: item.value?.type === 'Nudge',
    };
  }

  function messageBubbleClass(item) {
    return {
      'own-bubble': isOwnMessage(item),
      'other-bubble': !isOwnMessage(item) && item.value?.type === 'Message',
      'nudge-bubble': item.value?.type === 'Nudge',
    };
  }

  function displayActor(actor) {
    if (actor === session.value?.actor) return 'You';
    return 'User';
  }

  function scrollMessagesToBottom() {
    const box = document.querySelector('.messages-area');
    if (box) box.scrollTop = box.scrollHeight;
  }

  const chatFilter = ref(/** @type {'all' | 'nudges-sent' | 'nudges-received'} */ ('all'));

  const receivedVisibleNudgeChannelSet = computed(() => {
    const me = session.value?.actor;
    if (!me) return new Set();
    const objects = allChannelObjects.value;
    const out = new Set();
    for (const o of objects) {
      if (!o?.channels?.length) continue;
      if (o.value?.type !== 'Nudge' || o.actor === me) continue;
      if (nudgeTombstonedObjectUrls.value.has(o.url)) continue;
      const p = o.value?.published ?? 0;
      if (Date.now() - p > NUDGE_VISIBLE_MS) continue;
      for (const ch of o.channels) out.add(ch);
    }
    return out;
  });

  const visibleChats = computed(() => {
    const list = chats.value;
    if (chatFilter.value === 'nudges-sent') {
      return list.filter(c => ownVisibleNudgeMap.value[c.channel]);
    }
    if (chatFilter.value === 'nudges-received') {
      return list.filter(c => receivedVisibleNudgeChannelSet.value.has(c.channel));
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
    createChat,
    sendMessageToChannel,
    sendNudgeToChat,
    ownLatestNudgeForChannel,
    isChatNudgePending,
    formatTime,
    messageRowClass,
    messageBubbleClass,
    displayActor,
    ownVisibleNudgeMap,
    ownLatestNudgeMap,
    nudgeTombstonedObjectUrls,
    toggleNudgeForChannel,
    postNudgeWithEmoji,
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
        if (s.nudgeTombstonedObjectUrls.value.has(obj?.url)) return false;
        if (!obj.channels?.includes(ch)) return false;
        if (obj.value?.type === 'Message') return true;
        if (obj.value?.type === 'Nudge') {
          const p = obj.value?.published ?? 0;
          return Date.now() - p <= NUDGE_VISIBLE_MS;
        }
        return false;
      })
      .sort((a, b) => (a.value?.published || 0) - (b.value?.published || 0));
  });

  const activeChatOwnNudge = computed(() => {
    const ch = activeChat.value?.channel;
    if (!ch) return null;
    return s.ownVisibleNudgeMap.value[ch] ?? null;
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

  const nowTick = ref(Date.now());
  const nudgeBannerCountdown = computed(() => {
    const nudge = activeChatOwnNudge.value;
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
    activeChatOwnNudge,
    activeChatLatestNudge,
    composerNudgeButtonEmoji,
    nudgeBannerCountdown,
    showNudgeEmojiPicker,
    openComposerNudgeEmojiPicker,
    closeComposerNudgeEmojiPicker,
    pickOneOffNudgeEmoji,
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
      const n = s.ownLatestNudgeForChannel(chat.channel);
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
