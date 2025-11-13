// ---------- deps ----------
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionFlagsBits,
  Partials,
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
const RAW_DELAY_MS = 300;         // raw 백업 지연
const DUPE_WINDOW_MS = 5_000;     // 최근 중복 판단 시간창
const DUPE_FETCH_LIMIT = 10;      // 최근 몇 개 확인할지

// ---------- keepalive (Render 깨우기용, Discord와 상관없음) ----------
const fetchLazy = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

setInterval(async () => {
  try {
    if (!client?.ws || typeof client.ws.ping !== "number") {
      console.log("💓 Keepalive ping (1min) – waiting for ws ready...");
      return;
    }
    console.log(`💓 Keepalive ping (1min) – ${client.ws.ping}ms`);
    if (client.isReady()) {
      try { client.user.setPresence({ status: "online" }); } catch {}
    }
    const selfUrl = process.env.RENDER_EXTERNAL_URL || "https://discord-bot-atg4.onrender.com";
    await fetchLazy(selfUrl).then(() => console.log("🌍 Self-ping sent"));
  } catch (err) {
    console.error("Ping task error (ignored):", err?.message || err);
  }
}, 60 * 1000);

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

async function downloadAsAttachment(url, nameHint) {
  const res = await fetchLazy(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return new AttachmentBuilder(buf, { name: `SPOILER_${nameHint || "file"}` });
}

// **크로스-인스턴스 중복 방지: 최근 히스토리 검사**
const DUPE_WINDOW = DUPE_WINDOW_MS;
async function isRecentDuplicate({ channel, content, filesCount }) {
  try {
    const now = Date.now();
    const msgs = await channel.messages.fetch({ limit: DUPE_FETCH_LIMIT }).catch(() => null);
    if (!msgs) return false;

    for (const [, m] of msgs) {
      if (m.author?.id !== client.user.id) continue; // 내 봇이 올린 것만 비교
      const age = now - m.createdTimestamp;
      if (age > DUPE_WINDOW) continue;

      const sameContent = (m.content || "") === (content || "");
      const sameFiles = (m.attachments?.size || 0) === (filesCount || 0);
      if (sameContent && sameFiles) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function sendSpoilerAndMaybeDelete({
  channel,
  text,
  attachments,
  authorName,
  canDelete,
  messageId,
}) {
  const files = [];
  for (const att of attachments || []) {
    try {
      files.push(await downloadAsAttachment(att.url, att.filename || att.name));
    } catch (e) {
      console.error("⚠️ attachment fetch fail:", e?.message || e);
    }
  }

  const content = `${authorName ? authorName + ": " : ""}${wrapSpoiler(text || "")}`;
  if (!content && files.length === 0) {
    console.log("ℹ️ nothing to send (no text/attachments)");
    return;
  }

  // ⛔ 크로스-인스턴스 중복 방어막
  if (await isRecentDuplicate({ channel, content, filesCount: files.length })) {
    console.log("🛡️ skip send — recent duplicate detected");
  } else {
    await channel.send({ content, files }).catch((e) => {
      console.error("❌ send fail:", e?.message || e);
    });
  }

  if (canDelete && messageId) {
    await channel.messages.delete(messageId).catch((e) => {
      console.error("⚠️ delete fail (ignored):", e?.message || e);
    });
  }
}

// ---------- global dedupe (인스턴스 내) ----------
const processedIds = new Map(); // messageId -> ts
function wasProcessed(id) { return processedIds.has(id); }
function markProcessed(id) { processedIds.set(id, Date.now()); }
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

    // 가볍게 전송권한만 확인 (문제 없으면 그대로 두면 됨)
    await new Promise(r => setTimeout(r, 1200));
    await ch.send("🧪 Bot write probe (will delete)");
    console.log("✅ write probe: sent");
    if (has(PermissionFlagsBits.ManageMessages)) {
      const msgs = await ch.messages.fetch({ limit: 1 }).catch(() => null);
      const last = msgs?.first();
      if (last?.author?.id === client.user.id) {
        await last.delete().catch(() => {});
        console.log("✅ write probe: deleted");
      }
    }
  } catch (e) {
    console.error("❌ write probe fail:", e?.message || e);
  }
});

// 세션 완전 파괴될 때만 → 프로세스 종료 → Render가 재시작
client.on("invalidated", () => {
  console.error("🚫 Session invalidated — exiting for clean restart");
  process.exit(1);
});

client.on("error", (e) => {
  console.error("⚙️ Discord client error:", e?.message || e);
});
client.on("shardReconnecting", (_, id) => {
  console.warn(`♻️ Shard ${id} reconnecting (auto by discord.js)...`);
});
client.on("shardResume", (_, id) => {
  console.log(`🔗 Shard ${id} resumed`);
});

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

// ---------- FALLBACK: RAW MESSAGE_CREATE ----------
client.on("raw", async (p) => {
  try {
    if (p.t !== "MESSAGE_CREATE") return;
    if (!client.isReady()) return;

    const d = p.d || {};
    const channelId = d.channel_id;
    const messageId = d.id;

    await new Promise(r => setTimeout(r, RAW_DELAY_MS));
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
process.on("uncaughtException", (e) => {
  console.error("💥 Uncaught:", e?.message || e);
  // 치명적 에러면 프로세스 종료 → Render가 재시작
  process.exit(1);
});

// ---------- start ----------
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("❌ DISCORD_TOKEN is not set");
  process.exit(1);
}
client.login(token).catch((e) => {
  console.error("❌ Login failed:", e?.message || e);
  process.exit(1);
});

setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
