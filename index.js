// ---------- 기본 모듈 ----------
const express = require("express");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

// ---------- Express 서버 (Render가 포트 인식용으로 필요) ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive! ✅"));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// ---------- Discord 클라이언트 설정 ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- 채널 ID ----------
const SPOILER_CHANNEL_ID = "1421086622773936300";

// ---------- 로그인 재시도 로직 ----------
async function loginBot(retryCount = 0) {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ Discord bot login successful");
  } catch (err) {
    console.error("❌ Login failed:", err.message);
    if (retryCount < 5) {
      const wait = (retryCount + 1) * 5000; // 점점 늘어나는 재시도 간격
      console.log(`🔁 Retrying login in ${wait / 1000} sec...`);
      setTimeout(() => loginBot(retryCount + 1), wait);
    } else {
      console.error("⛔ Too many login failures. Will try again in 10 minutes.");
      setTimeout(() => loginBot(0), 10 * 60 * 1000);
    }
  }
}

// ---------- 이벤트: 봇 준비 완료 ----------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

// ---------- 이벤트: 메시지 생성 시 ----------
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channel.id !== SPOILER_CHANNEL_ID) return;

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
    console.error("💥 Message handler error:", err);
  }
});

// ---------- 예외 처리 ----------
process.on("unhandledRejection", (reason, p) => {
  console.error("🚨 Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});
client.on("shardDisconnect", (event, id) => {
  console.warn(`⚠️ Shard ${id} disconnected — attempting reconnect...`);
  loginBot();
});
client.on("error", (err) => {
  console.error("⚙️ Discord client error:", err.message);
});

// ---------- 실행 ----------
loginBot();
