// --------- deps ----------
const express = require("express");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

// --------- tiny web server (Render port binding) ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.send("Bot is alive ✅"));
app.listen(PORT, () => console.log(`🌐 Web server on :${PORT}`));

// --------- discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const SPOILER_CHANNEL_ID = "1421086622773936300";

// --------- single-flight login with backoff ----------
let loggingIn = false;
let loggedOnce = false;
let backoffMs = 5_000;        // 5s부터
const MAX_BACKOFF = 10 * 60_000; // 10분

async function safeLogin(force = false) {
  if (loggingIn && !force) return;
  loggingIn = true;
  try {
    console.log("🔐 Trying to login...");
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ Login OK");
    backoffMs = 5_000; // 성공하면 초기화
  } catch (e) {
    console.error("❌ Login failed:", e?.message || e);
    // 다음 재시도 예약 (지수백오프 상한 10분)
    setTimeout(() => safeLogin(false), backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
  } finally {
    loggingIn = false;
  }
}

// --------- lifecycle handlers ----------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
  loggedOnce = true;
});

// 게이트웨이 단절/오류시 자동 복구
function scheduleReconnect(reason) {
  console.warn(`⚠️ Reconnect scheduled (${reason}).`);
  try { client.destroy(); } catch {}
  setTimeout(() => {
    console.log("🔁 Forcing re-login...");
    safeLogin(true);
  }, 1000); // 1초 후 재로그인
}


client.on("shardDisconnect", (_event, id) => scheduleReconnect(`shard ${id} disconnect`));
client.on("shardError", (err, id) => { console.error(`💥 shard ${id} error:`, err?.message || err); scheduleReconnect("shardError"); });
client.on("error", (err) => { console.error("💥 client error:", err?.message || err); if (loggedOnce) scheduleReconnect("client error"); });

// 프로세스 레벨 예외도 죽지 않게
process.on("unhandledRejection", (r) => { console.error("🚨 UnhandledRejection:", r); if (loggedOnce) scheduleReconnect("unhandledRejection"); });
process.on("uncaughtException", (e) => { console.error("💥 UncaughtException:", e); if (loggedOnce) scheduleReconnect("uncaughtException"); });

// --------- main logic (spoiler-enforcer) ----------
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot || msg.channel.id !== SPOILER_CHANNEL_ID) return;

    const me = await msg.guild.members.fetchMe();
    const perms = msg.channel.permissionsFor(me);
    if (!perms?.has(["ViewChannel","SendMessages","ReadMessageHistory"])) return;

    const canManage = perms.has("ManageMessages");
    const canAttach = perms.has("AttachFiles");

    const prefix = `${msg.member?.displayName ?? msg.author.username}: `;
    const text = (msg.content ?? "").trim();
    const spoilerText = text ? `||${text}||` : "";

    const files = [];
    for (const [, att] of msg.attachments) {
      if (!canAttach) continue;
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      files.push(new AttachmentBuilder(buf, { name: `SPOILER_${att.name}` }));
    }

    if (!spoilerText && files.length === 0) return;

    await msg.channel.send({ content: `${prefix}${spoilerText}`, files });
    if (canManage) await msg.delete().catch(()=>{});
  } catch (err) {
    console.error("🧩 handler error:", err?.message || err);
  }
});

// --------- kick off ----------
safeLogin();

// 가끔 상태 로그(10분마다) — 살아있는지 확인용
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60_000);
