// ---------- deps ----------
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionFlagsBits,
  Partials,
  ChannelType,
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
    GatewayIntentBits.GuildMessages,  // messageCreate (있으면 사용, 없어도 RAW로 백업)
    GatewayIntentBits.MessageContent, // 본문 처리
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

// ---------- settings ----------
const SPOILER_CHANNEL_ID = "1421086622773936300";

// ---------- login manager ----------
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

// ---------- small utils ----------
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

// ---------- unified spoiler sender (channel object + raw payload both 지원) ----------
async function sendSpoilerAndDelete({ channel, text, attachments, authorName, canDelete, messageId }) {
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
    // 메시지 fetch 없이 ID로 바로 삭제 시도 (ManageMessages 필요)
    await channel.messages.delete(messageId).catch((e) => {
      console.error("⚠️ delete fail (ignored):", e?.message || e);
    });
  }
}

// ---------- events ----------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
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

// ---------- PRIMARY: messageCreate (정상 경로) ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!client.isReady()) return;
    if (msg.author?.bot) return;

    // 디버그
    console.log("[DBG] messageCreate", {
      guild: msg.guild?.id,
      channel: msg.channel?.id,
      type: msg.channel?.type,
      isThread: msg.channel?.isThread?.() || false,
      parentId: msg.channel?.parentId || null,
      contentLen: (msg.content || "").length,
      attachCnt: msg.attachments?.size || 0,
    });

    // 부모/동일 채널 판별
    const inTarget = isParentOrSameChannel(msg.channel, SPOILER_CHANNEL_ID);
    if (!inTarget) return;

    const me = msg.guild?.members?.me;
    const perms = msg.channel.permissionsFor(me);
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ];
    if (!perms || !perms.has(required, true)) {
      console.log("[DBG] skip by perms (messageCreate)", {
        exists: !!perms,
        bitfield: perms?.bitfield?.toString() || null,
      });
      return;
    }
    const canDelete = perms.has(PermissionFlagsBits.ManageMessages, true);

    await sendSpoilerAndDelete({
      channel: msg.channel,
      text: msg.content || "",
      attachments: [...msg.attachments.values()].map(a => ({ url: a.url, filename: a.name })),
      authorName: msg.member?.displayName ?? msg.author.username,
      canDelete,
      messageId: msg.id,
    });
  } catch (err) {
    console.error("💥 messageCreate handler error:", err?.message || err);
  }
});

// ---------- FALLBACK: RAW MESSAGE_CREATE (게이트웨이 이벤트 누락/특수 권한 문제 대비) ----------
client.on("raw", async (p) => {
  try {
    if (p.t !== "MESSAGE_CREATE") return;
    if (!client.isReady()) return;

    const d = p.d || {};
    const channelId = d.channel_id;
    const messageId = d.id;
    const guildId = d.guild_id;

    // 1) 채널 객체 확보 (본문/스레드 둘 다)
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.log("[DBG][RAW] skip: cannot fetch channel", { channelId });
      return;
    }

    // 2) 부모/동일 채널 판별 (스레드면 parentId 검사)
    const inTarget = isParentOrSameChannel(channel, SPOILER_CHANNEL_ID);
    if (!inTarget) return;

    // 3) 작성자 봇/권한 확인 (권한 부족이면 바로 스킵 로그)
    const guild = channel.guild ?? (guildId ? await client.guilds.fetch(guildId).catch(() => null) : null);
    const me = guild?.members?.me;
    const perms = channel.permissionsFor(me);
    if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], true)) {
      console.log("[DBG][RAW] skip by perms", {
        exists: !!perms, bitfield: perms?.bitfield?.toString() || null
      });
      return;
    }
    const canDelete = perms.has(PermissionFlagsBits.ManageMessages, true);

    // 4) 작성자가 봇이면 스킵
    if (d.author?.bot) return;

    // 5) RAW payload로 바로 처리 (fetch 없이)
    const authorName = d.member?.nick || d.author?.global_name || d.author?.username || "user";
    const text = d.content || "";
    const atts = (d.attachments || []).map(a => ({ url: a.url, filename: a.filename || a.name }));

    console.log("[DBG][RAW] processing", {
      channelId, messageId, isThread: channel.isThread?.() || false, parentId: channel.parentId || null,
      contentLen: text.length, attachCnt: atts.length
    });

    await sendSpoilerAndDelete({
      channel,
      text,
      attachments: atts,
      authorName,
      canDelete,
      messageId,
    });
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
