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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // 일부 환경에서 캐시 미스가 잦으면 partials 켜두면 조사에 도움됨(필수는 아님)
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

// ---------- keepalive ----------
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

// ---------- watchdog ----------
setInterval(() => {
  const s = client.ws?.status;
  if (s === Status.Disconnected) {
    console.warn("🛠️ Watchdog: Disconnected → safe re-login");
    safeLogin("watchdog");
  }
}, 45 * 1000);

// ---------- events ----------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
  try {
    const ch = await client.channels.fetch(SPOILER_CHANNEL_ID);
    console.log("[DBG] targetChannel", { id: ch?.id, type: ch?.type }); // 0=Text, 15=Forum, 5=News, 13=Stage, 11/12=Threads
  } catch (e) {
    console.log("[DBG] targetChannel fetch fail:", e?.message || e);
  }
});

client.on("invalidated", () => { console.warn("🚫 Session invalidated → safe re-login"); safeLogin("invalidated"); });
client.on("error", (e) => { console.error("⚙️ Discord client error:", e?.message || e); });
client.on("shardReconnecting", (_, id) => console.warn(`♻️ Shard ${id} reconnecting...`));
client.on("shardResume",      (_, id) => console.log(`🔗 Shard ${id} resumed`));

// —— RAW 이벤트도 찍어서 ‘아예 아무 패킷도 안 오나’ 확인 (잠깐만 켰다 끄세요)
client.on("raw", (p) => {
  if (p.t === "MESSAGE_CREATE" || p.t === "THREAD_CREATE") {
    console.log("[RAW]", p.t, {
      guild_id: p.d.guild_id,
      channel_id: p.d.channel_id,
      thread_id: p.d.id, // THREAD_CREATE일 때
      parent_id: p.d.parent_id,
    });
  }
});

// ---------- spoiler relay ----------
client.on("messageCreate", async (msg) => {
  try {
    if (!client.isReady()) return;

    // ★ 포럼/미디어 채널 대비: 부모가 대상 채널인 스레드도 허용 (임시 디버그)
    const inTarget =
      msg.channel.id === SPOILER_CHANNEL_ID ||
      (msg.channel.isThread?.() && msg.channel.parentId === SPOILER_CHANNEL_ID);

    // 디버그 로그 (들어오기만 해도 찍혀야 정상)
    console.log("[DBG] messageCreate", {
      authorBot: !!msg.author?.bot,
      guild: msg.guild?.id,
      channel: msg.channel?.id,
      type: msg.channel?.type,           // 15=Forum, 11/12=Threads
      isThread: msg.channel?.isThread?.() || false,
      parentId: msg.channel?.parentId || null,
      inTarget,
      contentLen: (msg.content || "").length,
      attachCnt: msg.attachments?.size || 0,
    });

    if (msg.author.bot || !inTarget) return;

    const me = msg.guild?.members?.me;
    const perms = msg.channel.permissionsFor(me);
    console.log("[DBG] perms", { exists: !!perms, bitfield: perms?.bitfield?.toString() || null });

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
  } catch (err) {
    console.error("💥 Message handler error:", err?.message || err);
  }
});

// ---------- hardening ----------
process.on("unhandledRejection", (r) => console.error("🚨 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("💥 Uncaught:", e));

// ---------- start ----------
loginBot();
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
