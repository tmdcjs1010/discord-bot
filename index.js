// ---------- deps ----------
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionFlagsBits,
  Partials,
  Status,
} = require("discord.js");

// ---------- tiny web server ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.send("✅ Bot running + heartbeat alive"));
app.listen(PORT, () => console.log(`🌐 Web server on :${PORT}`));

// ---------- discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // me 캐시 안정화
    GatewayIntentBits.GuildMessages,  // messageCreate
    GatewayIntentBits.MessageContent, // 본문 처리
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

// ---------- settings ----------
const SPOILER_CHANNEL_ID = "1421086622773936300";

// ---------- login manager (event-driven relogin) ----------
let loggingIn = false;
async function safeLogin(reason = "manual") {
  if (loggingIn) return;
  loggingIn = true;
  try {
    console.log(`🔐 safeLogin start (${reason})`);
    try { client.destroy(); } catch {}
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ safeLogin success");
  } catch (e) {
    console.error("❌ safeLogin failed:", e?.message || e);
  } finally {
    loggingIn = false;
  }
}
async function loginBot() { return safeLogin("initial"); }

// ---------- keepalive / watchdog ----------
const fetchLazy = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
setInterval(async () => {
  try {
    if (!client?.ws || typeof client.ws.ping !== "number") {
      console.log("💓 Keepalive ping (1min) – waiting for ws ready...");
      return;
    }
    console.log(`💓 Keepalive ping (1min) – ${client.ws.ping}ms`);
    if (client.isReady()) { try { client.user.setPresence({ status: "online" }); } catch {} }
    const selfUrl = process.env.RENDER_EXTERNAL_URL || "https://discord-bot-atg4.onrender.com";
    await fetchLazy(selfUrl).then(() => console.log("🌍 Self-ping sent"));
  } catch (err) { console.error("Ping task error (ignored):", err?.message || err); }
}, 60 * 1000);

setInterval(() => {
  if (client.ws?.status === Status.Disconnected) {
    console.warn("🛠️ Watchdog: Disconnected → safe re-login");
    safeLogin("watchdog");
  }
}, 45 * 1000);

// ---------- helpers ----------
function isTargetMessage(msg) {
  // 1) 텍스트 채널 본문
  if (msg.channel.id === SPOILER_CHANNEL_ID) return true;
  // 2) 스레드(포럼/미디어 포함)인데 부모가 대상 채널
  if (msg.channel.isThread?.() && msg.channel.parentId === SPOILER_CHANNEL_ID) return true;
  return false;
}

async function processSpoilerMessage(msg) {
  const me = msg.guild?.members?.me;
  if (!me) return;

  const perms = msg.channel.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (!perms || !perms.has(required, true)) return;

  const canManage = perms.has(PermissionFlagsBits.ManageMessages, true);
  const canAttach = perms.has(PermissionFlagsBits.AttachFiles, true);

  const prefix = `${msg.member?.displayName ?? msg.author.username}: `;
  const text = (msg.content ?? "").trim();

  // 이미 스포일러면 중복 감싸지 않음
  const alreadySpoiled = /^(\|\|)[\s\S]*\1$/.test(text);
  const spoilerText = text ? (alreadySpoiled ? text : `||${text}||`) : "";

  // 첨부 재업로드(스포일러 파일명)
  const files = [];
  for (const [, att] of msg.attachments) {
    if (!canAttach) continue;
    const res = await fetchLazy(att.url);
    const buf = Buffer.from(await res.arrayBuffer());
    files.push(new AttachmentBuilder(buf, { name: `SPOILER_${att.name}` }));
  }

  if (!spoilerText && files.length === 0) return;

  await msg.channel.send({ content: `${prefix}${spoilerText}`, files });
  if (canManage) await msg.delete().catch(() => {});
}

// ---------- dedupe (processed message ids) ----------
const processed = new Map(); // id -> timestamp
function markProcessed(id) { processed.set(id, Date.now()); }
function wasProcessed(id)  { return processed.has(id); }
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processed) if (now - ts > 5 * 60 * 1000) processed.delete(id);
}, 60 * 1000);

// ---------- events ----------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);

  // 대상 채널 타입 로깅
  try {
    const ch = await client.channels.fetch(SPOILER_CHANNEL_ID);
    console.log("[DBG] targetChannel", { id: ch?.id, type: ch?.type, name: ch?.name });
  } catch (e) {
    console.log("[DBG] targetChannel fetch fail:", e?.message || e);
  }
});

client.on("invalidated", () => { console.warn("🚫 Session invalidated → safe re-login"); safeLogin("invalidated"); });
client.on("error", (e) => { console.error("⚙️ Discord client error:", e?.message || e); });
client.on("shardReconnecting", (_, id) => console.warn(`♻️ Shard ${id} reconnecting...`));
client.on("shardResume",      (_, id) => console.log(`🔗 Shard ${id} resumed`));

// --- RAW: 페일세이프(최후 방어선). messageCreate가 안 올라오는 경우 직접 처리.
client.on("raw", async (p) => {
  try {
    if (p.t !== "MESSAGE_CREATE") return;

    const { channel_id, id: message_id, guild_id } = p.d || {};
    // 대상 채널(부모 채널)에서만 검사. 스레드는 messageCreate에서 잡습니다.
    if (channel_id !== SPOILER_CHANNEL_ID) return;
    if (!client.isReady()) return;
    if (wasProcessed(message_id)) return;

    // 메시지 객체를 fetch해서 표준 파이프라인으로 처리
    const channel = await client.channels.fetch(channel_id).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(message_id).catch(() => null);
    if (!msg) return;

    // 디버그
    console.log("[DBG][RAW→FETCH] MESSAGE_CREATE fetched", {
      guild: guild_id, channel: channel_id, id: message_id,
      authorBot: !!msg.author?.bot, contentLen: (msg.content||"").length,
      isThread: msg.channel?.isThread?.() || false, parentId: msg.channel?.parentId || null,
    });

    if (msg.author?.bot) { markProcessed(message_id); return; }
    if (!isTargetMessage(msg)) { markProcessed(message_id); return; }

    await processSpoilerMessage(msg);
    markProcessed(message_id);
  } catch (e) {
    console.error("💥 RAW handler error:", e?.message || e);
  }
});

// ★ 포럼/미디어: 스레드(게시물) 생성 시 starter message 처리
client.on("threadCreate", async (thread) => {
  try {
    if (!client.isReady()) return;
    if (thread.parentId !== SPOILER_CHANNEL_ID) return;

    console.log("[DBG] threadCreate", {
      threadId: thread.id, parentId: thread.parentId, type: thread.type, name: thread.name,
    });

    try { await thread.join(); } catch {}
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter && !starter.author?.bot) {
      if (!wasProcessed(starter.id)) {
        console.log("[DBG] process starter message", { id: starter.id, contentLen: (starter.content||"").length });
        await processSpoilerMessage(starter);
        markProcessed(starter.id);
      }
    }
  } catch (e) {
    console.error("💥 threadCreate handler error:", e?.message || e);
  }
});

// 스레드/본문 모든 메시지 처리(부모=대상 채널 조건)
client.on("messageCreate", async (msg) => {
  try {
    if (!client.isReady()) return;

    // 필수 디버그
    console.log("[DBG] messageCreate", {
      guild: msg.guild?.id,
      channel: msg.channel?.id,
      type: msg.channel?.type,
      isThread: msg.channel?.isThread?.() || false,
      parentId: msg.channel?.parentId || null,
      authorBot: !!msg.author?.bot,
      contentLen: (msg.content || "").length,
      attachCnt: msg.attachments?.size || 0,
    });

    if (msg.author?.bot) return;
    if (!isTargetMessage(msg)) return;

    if (wasProcessed(msg.id)) return;
    await processSpoilerMessage(msg);
    markProcessed(msg.id);
  } catch (err) {
    console.error("💥 messageCreate handler error:", err?.message || err);
  }
});

// ---------- hardening ----------
process.on("unhandledRejection", (r) => console.error("🚨 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("💥 Uncaught:", e));

// ---------- start ----------
loginBot();
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
