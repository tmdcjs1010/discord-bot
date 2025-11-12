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
  await channel.send({ content, files }).catch((e) => console.error("❌ send fail:", e?.message || e));
  if (canDelete && messageId) {
    await channel.messages.delete(messageId).catch((e) => console.error("⚠️ delete fail:", e?.message || e));
  }
}

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

    // 전송권한 즉시 검증(성공/실패 로그로 바로 판단)
    try {
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
  } catch (e) {
    console.log("[DBG] targetChannel fetch fail:", e?.message || e);
  }
});

// 정상 경로
client.on("messageCreate", async (msg) => {
  try {
    if (!client.isReady()) return;
    if (msg.author?.bot) return;
    if (!isParentOrSameChannel(msg.channel, SPOILER_CHANNEL_ID)) return;

    console.log("[DBG] messageCreate", {
      guild: msg.guild?.id, channel: msg.channel?.id,
      isThread: msg.channel?.isThread?.() || false, parentId: msg.channel?.parentId || null,
      contentLen: (msg.content || "").length, attachCnt: msg.attachments?.size || 0,
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
  } catch (err) {
    console.error("💥 messageCreate handler error:", err?.message || err);
  }
});

// 최후 방어선: RAW만 와도 동작
client.on("raw", async (p) => {
  try {
    if (p.t !== "MESSAGE_CREATE") return;
    if (!client.isReady()) return;

    const d = p.d || {};
    const channelId = d.channel_id;
    const messageId = d.id;
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
