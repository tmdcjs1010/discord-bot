const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

app.listen(3000, () => {
  console.log("🌐 Express server running on port 3000");
});


// index.js  (CommonJS 버전, Node 18+ 권장: global fetch 사용)
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');

// ✅ 스포일러 강제 적용할 채널 ID
const SPOILER_CHANNEL_ID = '1421086622773936300';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;                           // 봇 메시지 무시
    if (msg.channel.id !== SPOILER_CHANNEL_ID) return;    // 지정 채널만 처리

    // 권한 체크 (로그로 원인 파악)
    const me = await msg.guild.members.fetchMe();
    const perms = msg.channel.permissionsFor(me);
    if (!perms?.has(['ViewChannel','SendMessages','ReadMessageHistory'])) {
      console.log('⚠️ 권한 부족(View/Send/ReadMessageHistory)');
      return;
    }
    const canManage = perms.has('ManageMessages');
    const canAttach = perms.has('AttachFiles');

    // 작성자 표시 + 텍스트 스포일러 처리
    const prefix = `${msg.member?.displayName ?? msg.author.username}: `;
    const text = (msg.content ?? '').trim();
    const spoilerText = text ? `||${text}||` : '';

    // 첨부파일 스포일러: 파일명에 SPOILER_ 접두어 붙여 재업로드
    const files = [];
    for (const [, att] of msg.attachments) {
      if (!canAttach) {
        console.log('⚠️ AttachFiles 권한 없음 → 첨부 스킵');
        continue;
      }
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      files.push(new AttachmentBuilder(buf, { name: `SPOILER_${att.name}` }));
    }

    if (!spoilerText && files.length === 0) {
      console.log('ℹ️ 텍스트/첨부 없음 → 전송 스킵');
      return;
    }

    await msg.channel.send({ content: `${prefix}${spoilerText}`, files });
    console.log('✅ 스포일러 메시지 전송 완료');

    if (canManage) {
      await msg.delete().catch(e => console.log('⚠️ 원본 삭제 실패:', e.message));
    } else {
      console.log('⚠️ ManageMessages 권한 없음 → 원본 삭제 스킵');
    }
  } catch (e) {
    console.error('❌ spoiler bot error:', e);
  }
});

// 🔑 Replit의 Secrets(환경변수)에서 DISCORD_TOKEN 추가해두세요.
client.login(process.env.DISCORD_TOKEN);
