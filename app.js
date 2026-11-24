const { createApp, ref, nextTick, onUnmounted } = Vue;

/* ---------- Yordamchi funksiyalar ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const err = new Error("Serverga ulanib bo'lmadi. Server ishlayaptimi?");
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(typeof data?.detail === "string" ? data.detail : "Xatolik yuz berdi (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return data;
}

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });

/* ---------- Ilova (ildiz komponent) ---------- */
const App = {
  setup() {
    const token = ref(store.get("suhbat:token") || "");
    const user = ref(null);
    const rooms = ref([]);
    const room = ref(null);
    const ready = ref(false);
    const serverError = ref("");
    let poll = null;

    async function refreshRooms() {
      rooms.value = await api("/api/rooms", { token: token.value });
    }

    async function enter() {
      await refreshRooms();
      room.value = rooms.value.find((r) => r.name === "umumiy") || rooms.value[0] || null;
      clearInterval(poll);
      poll = setInterval(() => refreshRooms().catch(() => {}), 10000);
    }

    async function start() {
      if (token.value) {
        try {
          user.value = await api("/api/me", { token: token.value });
          await enter();
        } catch (e) {
          user.value = null;
          if (e.status === 401) { store.del("suhbat:token"); token.value = ""; }
          else serverError.value = e.message;
        }
      }
      ready.value = true;
    }

    async function onAuth(data) {
      token.value = data.token;
      store.set("suhbat:token", data.token);
      user.value = data.user;
      serverError.value = "";
      await enter();
    }

    async function logout(callServer = true) {
      if (callServer) { try { await api("/api/logout", { method: "POST", token: token.value }); } catch {} }
      clearInterval(poll);
      store.del("suhbat:token");
      token.value = ""; user.value = null; room.value = null; rooms.value = [];
    }

    async function onCreated(r) {
      await refreshRooms();
      room.value = rooms.value.find((x) => x.id === r.id) || room.value;
    }

    start();
    return { token, user, rooms, room, ready, serverError, onAuth, logout, onCreated };
  },
  template: `
    <div v-if="!ready" class="boot">Yuklanmoqda…</div>
    <auth-form v-else-if="!user" :server-error="serverError" @done="onAuth" />
    <div v-else class="app">
      <room-list :token="token" :user="user" :rooms="rooms" :current="room ? room.id : 0"
                 @select="room = $event" @created="onCreated" @logout="logout()" />
      <chat-panel v-if="room" :key="room.id" :token="token" :user="user" :room="room" @logout="logout(false)" />
    </div>`,
};

const app = createApp(App);

/* ---------- Komponent 1: kirish / ro'yxatdan o'tish ---------- */
app.component("auth-form", {
  props: ["serverError"],
  emits: ["done"],
  setup(props, { emit }) {
    const mode = ref("login");
    const username = ref("");
    const password = ref("");
    const error = ref("");
    const busy = ref(false);

    async function submit() {
      error.value = "";
      busy.value = true;
      try {
        const data = await api("/api/" + mode.value, {
          method: "POST",
          body: { username: username.value, password: password.value },
        });
        emit("done", data);
      } catch (e) {
        error.value = e.message;
      } finally {
        busy.value = false;
      }
    }
    return { mode, username, password, error, busy, submit };
  },
  template: `
    <section class="login">
      <div class="login-art"><div><h1>Suhbat</h1><p>Do'stlaringiz bilan real vaqtda yozishing.</p></div></div>
      <div class="login-form">
        <form @submit.prevent="submit">
          <h2>{{ mode === 'login' ? 'Kirish' : "Ro'yxatdan o'tish" }}</h2>
          <p class="err" v-if="serverError">{{ serverError }}</p>
          <label>Login
            <input type="text" v-model="username" maxlength="20" required autocomplete="username">
          </label>
          <label>Parol
            <input type="password" v-model="password" maxlength="100" required
                   :autocomplete="mode === 'login' ? 'current-password' : 'new-password'">
          </label>
          <p class="err" v-if="error">{{ error }}</p>
          <button class="btn" type="submit" :disabled="busy">
            {{ mode === 'login' ? 'Kirish' : "Ro'yxatdan o'tish" }}
          </button>
          <button class="switch" type="button" @click="mode = mode === 'login' ? 'register' : 'login'; error = ''">
            {{ mode === 'login' ? "Akkaunt yo'qmi? Ro'yxatdan o'ting" : "Akkauntingiz bormi? Kirish" }}
          </button>
        </form>
      </div>
    </section>`,
});

/* ---------- Komponent 2: xonalar ro'yxati ---------- */
app.component("room-list", {
  props: ["token", "user", "rooms", "current"],
  emits: ["select", "created", "logout"],
  setup(props, { emit }) {
    const name = ref("");
    const error = ref("");

    async function add() {
      error.value = "";
      try {
        const r = await api("/api/rooms", { method: "POST", token: props.token, body: { name: name.value } });
        name.value = "";
        emit("created", r);
      } catch (e) {
        error.value = e.message;
      }
    }
    return { name, error, add };
  },
  template: `
    <aside class="side">
      <div><h3>Suhbat</h3><p class="who">Siz: {{ user.username }}</p></div>
      <h4>Xonalar</h4>
      <ul class="rooms">
        <li v-for="r in rooms" :key="r.id">
          <button type="button" :class="{ active: r.id === current }" @click="$emit('select', r)">
            <span># {{ r.name }}</span><small>{{ r.online }} onlayn</small>
          </button>
        </li>
      </ul>
      <form class="newroom" @submit.prevent="add">
        <input type="text" v-model="name" maxlength="24" placeholder="Yangi xona" aria-label="Yangi xona nomi" required>
        <button class="btn" type="submit" aria-label="Xona qo'shish">+</button>
      </form>
      <p class="err" v-if="error">{{ error }}</p>
      <button class="leave" type="button" @click="$emit('logout')">Chiqish</button>
    </aside>`,
});

/* ---------- Komponent 3: chat oynasi ---------- */
app.component("chat-panel", {
  props: ["token", "user", "room"],
  emits: ["logout"],
  setup(props, { emit }) {
    const messages = ref([]);
    const users = ref([]);
    const text = ref("");
    const status = ref("connecting");
    const error = ref("");
    const feed = ref(null);
    let socket = null, retry = 0, timer = null, closed = false;

    async function scrollDown() {
      await nextTick();
      if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
    }

    async function loadHistory() {
      messages.value = await api(`/api/rooms/${props.room.id}/messages`, { token: props.token });
      scrollDown();
    }

    function connect() {
      clearTimeout(timer);
      status.value = "connecting";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(
        `${proto}://${location.host}/ws?token=${encodeURIComponent(props.token)}&room_id=${props.room.id}`
      );
      socket.onopen = () => {
        retry = 0;
        status.value = "online";
        loadHistory().catch(() => {});
      };
      socket.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.type === "message") { messages.value.push(d); scrollDown(); }
        else if (d.type === "deleted") messages.value = messages.value.filter((m) => m.id !== d.id);
        else if (d.type === "presence") users.value = d.users;
      };
      socket.onclose = async () => {
        if (closed) return;
        status.value = "offline";
        try { await api("/api/me", { token: props.token }); }
        catch (e) { if (e.status === 401) { emit("logout"); return; } }
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, retry * 1000);
      };
    }

    function send() {
      const t = text.value.trim();
      if (!t || !socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ text: t }));
      text.value = "";
    }

    async function remove(m) {
      error.value = "";
      try { await api("/api/messages/" + m.id, { method: "DELETE", token: props.token }); }
      catch (e) { error.value = e.message; }
    }

    connect();
    onUnmounted(() => {
      closed = true;
      clearTimeout(timer);
      if (socket) { socket.onclose = null; socket.close(); }
    });

    const statusText = { online: "Ulangan", connecting: "Ulanmoqda…", offline: "Aloqa uzildi" };
    return { messages, users, text, status, statusText, error, feed, send, remove, fmtTime };
  },
  template: `
    <section class="chat">
      <div class="topbar">
        <div>
          <strong># {{ room.name }}</strong>
          <div class="muted">Onlayn ({{ users.length }}): {{ users.join(', ') || '—' }}</div>
        </div>
        <span class="badge" :class="status">{{ statusText[status] }}</span>
      </div>
      <div class="feed" ref="feed" aria-live="polite">
        <p v-if="!messages.length" class="empty">Hali xabar yo'q. Birinchi bo'lib yozing.</p>
        <div v-for="m in messages" :key="m.id" class="msg" :class="{ me: m.user_id === user.id }">
          <div class="meta">
            <strong>{{ m.username }}</strong><span>{{ fmtTime(m.ts) }}</span>
            <button v-if="m.user_id === user.id" class="x" type="button" title="O'chirish" aria-label="Xabarni o'chirish" @click="remove(m)">×</button>
          </div>
          <div class="text">{{ m.text }}</div>
        </div>
      </div>
      <div class="composer-err" v-if="error"><p class="err">{{ error }}</p></div>
      <form class="composer" autocomplete="off" @submit.prevent="send">
        <input type="text" v-model="text" maxlength="1000" placeholder="Xabar yozing…" aria-label="Xabar" required>
        <button class="btn" type="submit">Yuborish</button>
      </form>
    </section>`,
});

app.mount("#app");
