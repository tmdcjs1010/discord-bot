// ---------- 기본 모듈 ----------
const express = require("express");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

// ---------- Express 서버 (Render 포트 감지용) ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.send("✅ Bot is running fine."));
app.listen(PORT, () => console.log(`🌐 Web server on :${PORT}`));

// ---------- Discord 클라이언트 ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const SPOILER_CHANNEL_ID = "1421086622773936300";

// ---------- 로그인 함수 ----------
async function loginBot() {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ Discord bot logged in successfully");
  } catch (err) {
    console.error("❌ Login failed:", err.message);
    console.log("🔁 Retrying login in 10 seconds...");
    setTimeout(loginBot, 10000);
  }
}

// ---------- 자동 재로그인 타이머 (30분마다) ----------
setInterval(() => {
  console.log("🔄 Auto re-login triggered (30min heartbeat)");
  try {
    client.destroy();
  } catch {}
  loginBot();
}, 30 * 60 * 1000); // 30분 간격

// ---------- 디스코드 연결 이벤트 ----------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

// ---------- 메시지 처리 ----------
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot || msg.channel.id !== SPOILER_CHANNEL_ID) return;

    const me = await msg.guild.members.fetchMe();
    const perms = msg.channel.permissionsFor(me);
    if (!perms?.has(["ViewChannel", "SendMessages", "ReadMessageHistory"])) return;

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
    if (canManage) await msg.delete().catch(() => {});
  } catch (err) {
    console.error("💥 Message handler error:", err.message);
  }
});

// ---------- 예외/오류 핸들러 ----------
process.on("unhandledRejection", (reason) => {
  console.error("🚨 Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});
client.on("error", (err) => {
  console.error("⚙️ Discord client error:", err.message);
  setTimeout(loginBot, 5000);
});
client.on("shardDisconnect", () => {
  console.warn("⚠️ Shard disconnected, re-login...");
  setTimeout(loginBot, 5000);
});

// ---------- 시작 ----------
loginBot();

// ---------- 상태 확인용 하트비트 ----------
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
