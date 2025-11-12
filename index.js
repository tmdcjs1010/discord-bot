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
    GatewayIntentBits.GuildMembers, // 안전하게 me 캐시
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

// ---------- helpers ----------
function isFromTargetChannel(msg) {
  // ① 부모 포럼 채널 본문(거의 없음) or ② 부모가 대상 채널인 스레드
  return (
    msg.channel.id === SPOILER_CHANNEL_ID ||
    (msg.channel.isThread?.() && msg.channel.parentId === SPOILER_CHANNEL_ID)
  );
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

// ---------- events ----------
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

client.on("invalidated", () => { console.warn("🚫 Session invalidated → safe re-login"); safeLogin("invalidated"); });
client.on("error", (e) => { console.error("⚙️ Discord client error:", e?.message || e); });
client.on("shardReconnecting", (_, id) => console.warn(`♻️ Shard ${id} reconnecting...`));
client.on("shardResume",      (_, id) => console.log(`🔗 Shard ${id} resumed`));

// ★ 포럼/미디어 채널: 게시물(스레드) 생성 시 starter message를 바로 처리
client.on("threadCreate", async (thread) => {
  try {
    if (!client.isReady()) return;
    if (thread.parentId !== SPOILER_CHANNEL_ID) return;

    // private thread 대비: 조인(공개라도 join 해두면 안정적)
    try { await thread.join(); } catch {}

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter && !starter.author?.bot) {
      await processSpoilerMessage(starter);
    }
  } catch (e) {
    console.error("💥 threadCreate handler error:", e?.message || e);
  }
});

// 스레드 안의 일반 메시지도 처리(부모가 대상 채널인 경우에만)
client.on("messageCreate", async (msg) => {
  try {
    if (!client.isReady()) return;
    if (msg.author?.bot) return;
    if (!isFromTargetChannel(msg)) return;

    await processSpoilerMessage(msg);
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
