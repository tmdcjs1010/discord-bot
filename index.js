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

// ---------- tiny web server (Render port binding) ----------
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

// ---------- login manager (token hard-set + event-driven relogin) ----------
let loggingIn = false;
async function safeLogin(reason = "manual") {
  if (loggingIn) return;
  loggingIn = true;
  try {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN is empty");

    console.log(`🔐 safeLogin start (${reason})`);

    // REST 토큰 선세팅(일부 환경 초기 레이스 회피)
    try { client.rest.setToken(token); } catch {}

    // 게이트웨이가 완전 끊긴 상태면 정리
    if (client.ws?.status === Status.Disconnected) {
      try { await client.destroy(); } catch {}
    }

    await client.login(token);

    // login 이후에도 한 번 더 세팅
    try { client.rest.setToken(token); } catch {}

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
  } catch (err) {
    console.error("Ping task error (ignored):", err?.message || err);
  }
}, 60 * 1000);

// 게이트웨이가 완전 끊긴 경우에만 재로그인 시도
setInterval(() => {
  if (client.ws?.status === Status.Disconnected) {
    console.warn("🛠️ Watchdog: Disconnected → safe re-login");
    safeLogin("watchdog");
  }
}, 45 * 1000);

// ---------- utils ----------
function isParentOrSameChannel(channel, parentId) {
  if (!channel) return false;
  if (channel.id === parentId) return true;
  if (channel.isThread?.() && channel.parentId === parentId) return true;
  return false;
}
function wrapSpoiler(text) {
  if (!text) return "";
  const already = /^(\|\|)[\s\S]*\1$/.test(text.trim());
  return already ? text : `||${text}||`;
}
async function sendSpoilerAndMaybeDelete({ channel, text, attachments, authorName, canDelete, messageId }) {
  const files = [];
  for (const att of attachments || []) {
    try {
      const res = await fetchLazy(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      files.push(new AttachmentBuilder(buf, { name: `SPOILER_${att.filename || att.name || "file"}` }));
    } catch (e) {
      console.error("⚠️ attachment fetch fail:", e?.message || e);
    }
  }

  const content = `${authorName ? authorName + ": " : ""}${wrapSpoiler(text || "")}`;
  if (!content && files.length === 0) {
    console.log("ℹ️ nothing to send (no text/attachments)");
    return;
  }

  await channel.send({ content, files }).catch((e) => {
    console.error("❌ send fail:", e?.message || e);
  });

  if (canDelete && messageId) {
    // 메시지 fetch 없이 ID만으로 삭제 시도
    await channel.messages.delete(messageId).catch((e) => {
      console.error("⚠️ delete fail (ignored):", e?.message || e);
    });
  }
}

// ---------- global dedupe ----------
const processedIds = new Map(); // messageId -> ts
function wasProcessed(id) { return processedIds.has(id); }
function markProcessed(id) { processedIds.set(id, Date.now()); }
// 10분 TTL 청소
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedIds) {
    if (now - ts > 10 * 60 * 1000) processedIds.delete(id);
  }
}, 60 * 1000);

// ---------- events ----------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);

  // 채널/권한 프로브
  try {
    const ch = await client.channels.fetch(SPOILER_CHANNEL_ID);
    const me = ch.guild?.members?.me;
    const perms = ch.permissionsFor(me);
    const has = (p) => (perms ? perms.has(p, true) : false);
    console.log("[DBG] targetChannel", { id: ch?.id, type: ch?.type, name: ch?.name });
    console.log("[DBG] perms bitfield:", perms?.bitfield?.toString() || null);
    console.log("[DBG] perms detail:", {
      ViewChannel: has(PermissionFlagsBits.ViewChannel),
      SendMessages: has(PermissionFlagsBits.SendMessages),
      ReadMessageHistory: has(PermissionFlagsBits.ReadMessageHistory),
      ManageMessages: has(PermissionFlagsBits.ManageMessages),
      AttachFiles: has(PermissionFlagsBits.AttachFiles),
    });

    // 토큰/세션 안정화 대기 후 전송권한 즉시 검증
    await new Promise(r => setTimeout(r, 1500));
    await ch.send("🧪 Bot write probe (will delete)");
    console.log("✅ write probe: sent");
    if (has(PermissionFlagsBits.ManageMessages)) {
      const msgs = await ch.messages.fetch({ limit: 1 }).catch(() => null);
      const last = msgs?.first();
      if (last?.author?.id === client.user.id) {
        await last.delete().catch(() => {});
        console.log("✅ write probe: deleted");
      }
    } else {
      console.log("ℹ️ ManageMessages 없음 → probe 메시지는 남아있을 수 있음");
    }
  } catch (e) {
    console.error("❌ write probe fail:", e?.message || e);
  }
});

client.on("invalidated", () => {
  console.warn("🚫 Session invalidated → safe re-login");
  safeLogin("invalidated");
});
client.on("error", (e) => { console.error("⚙️ Discord client error:", e?.message || e); });
client.on("shardReconnecting", (_, id) => { console.warn(`♻️ Shard ${id} reconnecting...`); });
client.on("shardResume",      (_, id) => { console.log(`🔗 Shard ${id} resumed`); });

// ---------- PRIMARY: messageCreate ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!client.isReady()) return;
    if (msg.author?.bot) return;
    if (wasProcessed(msg.id)) return; // RAW가 먼저 처리했을 수 있음
    if (!isParentOrSameChannel(msg.channel, SPOILER_CHANNEL_ID)) return;

    console.log("[DBG] messageCreate", {
      guild: msg.guild?.id,
      channel: msg.channel?.id,
      isThread: msg.channel?.isThread?.() || false,
      parentId: msg.channel?.parentId || null,
      contentLen: (msg.content || "").length,
      attachCnt: msg.attachments?.size || 0,
    });

    const me = msg.guild?.members?.me;
    const perms = msg.channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], true)) {
      console.log("[DBG] skip by perms (messageCreate)", { bitfield: perms?.bitfield?.toString() || null });
      return;
    }
    const canDelete = perms.has(PermissionFlagsBits.ManageMessages, true);

    await sendSpoilerAndMaybeDelete({
      channel: msg.channel,
      text: msg.content || "",
      attachments: [...msg.attachments.values()].map(a => ({ url: a.url, filename: a.name })),
      authorName: msg.member?.displayName ?? msg.author.username,
      canDelete,
      messageId: msg.id,
    });

    markProcessed(msg.id);
  } catch (err) {
    console.error("💥 messageCreate handler error:", err?.message || err);
  }
});

// ---------- FALLBACK: RAW MESSAGE_CREATE (게이트웨이 이벤트 누락 대비) ----------
client.on("raw", async (p) => {
  try {
    if (p.t !== "MESSAGE_CREATE") return;
    if (!client.isReady()) return;

    const d = p.d || {};
    const channelId = d.channel_id;
    const messageId = d.id;

    // messageCreate가 먼저 처리할 시간을 잠깐 준 뒤 확인
    await new Promise(r => setTimeout(r, 300));
    if (wasProcessed(messageId)) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    if (!isParentOrSameChannel(channel, SPOILER_CHANNEL_ID)) return;
    if (d.author?.bot) return;

    const guild = channel.guild ?? (d.guild_id ? await client.guilds.fetch(d.guild_id).catch(() => null) : null);
    const me = guild?.members?.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], true)) {
      console.log("[DBG][RAW] skip by perms", { bitfield: perms?.bitfield?.toString() || null });
      return;
    }
    const canDelete = perms.has(PermissionFlagsBits.ManageMessages, true);

    const authorName = d.member?.nick || d.author?.global_name || d.author?.username || "user";
    const text = d.content || "";
    const atts = (d.attachments || []).map(a => ({ url: a.url, filename: a.filename || a.name }));

    console.log("[DBG][RAW] processing", {
      channelId, messageId,
      isThread: channel.isThread?.() || false, parentId: channel.parentId || null,
      contentLen: text.length, attachCnt: atts.length
    });

    await sendSpoilerAndMaybeDelete({
      channel,
      text,
      attachments: atts,
      authorName,
      canDelete,
      messageId,
    });

    markProcessed(messageId);
  } catch (e) {
    console.error("💥 RAW handler error:", e?.message || e);
  }
});

// ---------- hardening ----------
process.on("unhandledRejection", (r) => console.error("🚨 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("💥 Uncaught:", e));

// ---------- start ----------
loginBot();
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
