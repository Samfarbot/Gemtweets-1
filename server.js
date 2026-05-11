// TweetPulse — server.js
// Monitors @GemisAlpha → sends all tweets + RTs to @gemtweets
// Deploy on Render (free tier) — self-pings to stay alive 24/7

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cron    = require('node-cron');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────
const BOT_TOKEN  = '8725848636:AAGO7T0VBVSZXdHOaWexAJMsMWcYxbg170U';
const CHAT_ID    = '@gemtweets';
const HANDLE     = 'GemisAlpha';
const POLL_EVERY = 2; // minutes

// Render sets this automatically — used for self-ping keepalive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';

// Nitter fallback chain
const NITTER_HOSTS = [
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.net',
  'https://nitter.1d4.us',
];

// ─── STATE ─────────────────────────────────────────────────
let lastTweetId = null;
let isFirstRun  = true;
let pollErrors  = 0;
const logs      = [];

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ─── SCRAPE VIA NITTER RSS ─────────────────────────────────
async function getLatestTweets() {
  for (const host of NITTER_HOSTS) {
    try {
      const url = `${host}/${HANDLE}/rss`;
      addLog('info', `Trying ${host}...`);

      const { data } = await axios.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        }
      });

      // Make sure we got actual RSS, not an error page
      if (!data || !data.includes('<item>')) {
        addLog('warn', `${host} returned invalid RSS — skipping`);
        continue;
      }

      const $ = cheerio.load(data, { xmlMode: true });
      const items = [];

      $('item').each((_, el) => {
        const title   = $(el).find('title').text().trim();
        const link    = $(el).find('link').text().trim();
        const guid    = $(el).find('guid').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        items.push({ title, link, guid, pubDate });
      });

      if (!items.length) {
        addLog('warn', `${host} returned 0 items — skipping`);
        continue;
      }

      addLog('info', `Fetched ${items.length} tweets via ${host}`);
      return items;

    } catch (err) {
      addLog('warn', `${host} failed: ${err.message}`);
    }
  }

  addLog('error', 'All Nitter hosts failed this round');
  return [];
}

// ─── TELEGRAM ──────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      },
      { timeout: 10000 }
    );

    if (!res.data.ok) {
      addLog('error', `Telegram API error: ${JSON.stringify(res.data)}`);
    } else {
      addLog('success', 'Telegram notification sent ✅');
    }
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    addLog('error', `Telegram failed: ${detail}`);
  }
}

// ─── BUILD MESSAGE ─────────────────────────────────────────
function buildMessage(tweet) {
  const isRT    = tweet.title.startsWith('RT @');
  const isReply = tweet.title.startsWith('@');
  const icon    = isRT ? '🔁' : isReply ? '💬' : '🐦';
  const type    = isRT ? 'Retweeted' : isReply ? 'Replied' : 'New Tweet';

  // Convert any nitter link → x.com
  const twitterLink = tweet.link.replace(/https?:\/\/nitter\.[^/]+\//, 'https://x.com/');

  return (
    `${icon} <b>@${HANDLE} — ${type}</b>\n\n` +
    `${tweet.title}\n\n` +
    `🔗 <a href="${twitterLink}">View on Twitter/X</a>\n` +
    `<i>${tweet.pubDate}</i>`
  );
}

// ─── MAIN POLL ─────────────────────────────────────────────
async function poll() {
  addLog('info', `Polling @${HANDLE}...`);
  const tweets = await getLatestTweets();
  if (!tweets.length) return;

  const latest = tweets[0];

  // First run: set baseline silently — don't spam old tweets
  if (isFirstRun) {
    lastTweetId = latest.guid;
    isFirstRun  = false;
    addLog('info', `✅ Baseline set — watching @${HANDLE} from now`);
    return;
  }

  // Nothing new
  if (lastTweetId === latest.guid) {
    addLog('info', `@${HANDLE} — no new tweets`);
    return;
  }

  // Collect all new tweets since last seen
  const newTweets = [];
  for (const tweet of tweets) {
    if (tweet.guid === lastTweetId) break;
    newTweets.push(tweet);
  }

  // If the full list is new (e.g. bot was offline for a while), cap at 5 to avoid spam
  if (newTweets.length === tweets.length) {
    addLog('warn', 'Many new tweets detected — capping at 5 to avoid spam');
    newTweets.splice(5);
  }

  // Send oldest first (chronological)
  for (const tweet of newTweets.reverse()) {
    await sendTelegram(buildMessage(tweet));
    await new Promise(r => setTimeout(r, 1500));
  }

  lastTweetId = latest.guid;
  addLog('success', `Notified: ${newTweets.length} new tweet(s) from @${HANDLE}`);
}

// ─── SAFE POLL WRAPPER ─────────────────────────────────────
// Catches any crash so cron never silently dies
async function safePoll() {
  try {
    await poll();
    pollErrors = 0;
  } catch (err) {
    pollErrors++;
    addLog('error', `Unhandled poll error #${pollErrors}: ${err.message}`);
    if (pollErrors === 5) {
      await sendTelegram('⚠️ <b>TweetPulse</b>: 5 consecutive errors. Still running — check /logs.').catch(() => {});
    }
  }
}

// ─── SELF-PING KEEPALIVE ───────────────────────────────────
// Prevents Render free tier from sleeping (spins down after 15min idle)
function startKeepalive() {
  if (!SELF_URL) {
    addLog('warn', 'RENDER_EXTERNAL_URL not found — keepalive inactive. Render should set this automatically.');
    return;
  }

  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 8000 });
      addLog('info', '🏓 Keepalive ping OK');
    } catch (err) {
      addLog('warn', `Keepalive ping failed: ${err.message}`);
    }
  }, 10 * 60 * 1000); // every 10 minutes

  addLog('info', `🏓 Keepalive active — pinging ${SELF_URL}/health every 10min`);
}

// ─── CRON ──────────────────────────────────────────────────
cron.schedule(`*/${POLL_EVERY} * * * *`, safePoll);
addLog('info', `⏱ Cron: polling every ${POLL_EVERY} minutes`);

// ─── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status     : 'running ✅',
    watching   : `@${HANDLE}`,
    notifying  : CHAT_ID,
    pollEvery  : `${POLL_EVERY} min`,
    lastTweetId,
    pollErrors,
    uptime     : `${Math.floor(process.uptime() / 60)} min`,
    recentLogs : logs.slice(0, 10),
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/logs', (req, res) => {
  res.json(logs);
});

// Manually trigger a poll (useful for testing)
app.post('/force-poll', async (req, res) => {
  addLog('info', 'Force poll triggered via /force-poll');
  await safePoll();
  res.json({ ok: true });
});

// ─── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  addLog('info', `🚀 TweetPulse live on port ${PORT}`);
  addLog('info', `👁  Watching @${HANDLE} → ${CHAT_ID}`);

  // First poll 5s after boot
  setTimeout(safePoll, 5000);

  // Start keepalive after 15s (give server time to settle)
  setTimeout(startKeepalive, 15000);
});

// ─── PREVENT CRASHES FROM KILLING THE PROCESS ──────────────
process.on('unhandledRejection', (reason) => {
  addLog('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  addLog('error', `Uncaught exception: ${err.message} — continuing`);
  // intentionally NOT calling process.exit() — keep the server alive
});
