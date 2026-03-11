const express = require("express");
const axios   = require("axios");
const app     = express();
app.use(express.json());

const C = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "YOUR_BOT_TOKEN",
  TELEGRAM_CHAT:  process.env.TELEGRAM_CHAT  || "YOUR_CHAT_ID",
  GEMINI_KEY:     process.env.GEMINI_KEY     || "YOUR_GEMINI_KEY",
  SECRET:         process.env.WEBHOOK_SECRET || "smc2025",
  PORT:           process.env.PORT           || 3000,
  ACCOUNT_USD:    parseFloat(process.env.ACCOUNT_SIZE   || "500"),
  RISK_PCT:       parseFloat(process.env.RISK_PERCENT   || "1.0"),
  MAX_LOSS_PCT:   parseFloat(process.env.MAX_DAILY_LOSS || "3.0"),
};

let state = {
  dailyLoss: 0, signals: 0,
  lastReset: new Date().toDateString(),
  lastSignal: null, tradeLog: [],
};

function checkDailyReset() {
  const today = new Date().toDateString();
  if (state.lastReset !== today) {
    state.dailyLoss = 0;
    state.lastReset = today;
    state.tradeLog  = [];
  }
}

function calcLot(entry, sl, symbol = "") {
  const riskUSD = C.ACCOUNT_USD * (C.RISK_PCT / 100);
  const slDist  = Math.abs(entry - sl);
  if (slDist === 0) return { lot: "0.01", riskUSD: riskUSD.toFixed(2), slPips: "0" };
  let pipVal = 10;
  const sym = symbol.toUpperCase();
  if (sym.includes("XAU")) pipVal = 100;
  if (sym.includes("JPY")) pipVal = 9.09;
  const lot = Math.max(0.01, (riskUSD / (slDist * pipVal))).toFixed(2);
  return { lot, riskUSD: riskUSD.toFixed(2), slPips: slDist.toFixed(sym.includes("XAU") ? 2 : 4) };
}

async function getNews() {
  try {
    const r = await axios.get("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { timeout: 6000 });
    const now = Date.now();
    const win = now + 2 * 60 * 60 * 1000;
    const ev  = r.data
      .filter(e => { const t = new Date(e.date).getTime(); return t >= now && t <= win && e.impact === "High"; })
      .map(e => {
        const t = new Date(e.date).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
        return `⚠️ [${e.currency}] ${e.title} เวลา ${t}`;
      }).slice(0, 3);
    return ev.length ? "📅 ข่าว High Impact ใน 2 ชม.:\n" + ev.join("\n") : "✅ ไม่มีข่าวสำคัญใน 2 ชม.";
  } catch { return "📅 ดึงข่าวไม่ได้"; }
}

async function analyzeGemini(signal, lotInfo, news) {
  const rr = signal.tp2 && signal.sl
    ? (Math.abs(signal.tp2 - signal.price) / Math.abs(signal.price - signal.sl)).toFixed(1) : "3";
  const prompt = `คุณคือผู้เชี่ยวชาญ SMC Trading วิเคราะห์ Signal นี้เป็นภาษาไทย กระชับ (ไม่เกิน 180 คำ):
Signal: ${signal.signal} ${signal.symbol} TF:${signal.timeframe}
Entry: ${signal.price} | SL: ${signal.sl} | TP1: ${signal.tp1} | TP2: ${signal.tp2} | RR: 1:${rr}
Lot: ${lotInfo.lot} | Risk: $${lotInfo.riskUSD}
${news}
วิเคราะห์ 4 ข้อ:
1. 🎯 ความน่าเชื่อถือ (HIGH/MEDIUM/LOW) + เหตุผล
2. 🔧 แก้ไม้ถ้าราคาสวนทาง
3. 💰 บริหารทุน Partial TP
4. ✅ สรุป Action`;
  try {
    const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${C.GEMINI_KEY}`;
    const resp = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 512, temperature: 0.4 },
    }, { timeout: 20000 });
    return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ Gemini ไม่ตอบ";
  } catch (err) {
    return "⚠️ AI วิเคราะห์ไม่ได้ขณะนี้";
  }
}

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${C.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: C.TELEGRAM_CHAT, text, parse_mode: "HTML",
    });
  } catch (err) { console.error("Telegram error:", err.message); }
}

function formatMsg(signal, lotInfo, aiText, news) {
  const isLong = signal.signal === "LONG";
  const emoji  = isLong ? "🟢" : "🔴";
  const dir    = isLong ? "BUY  ▲" : "SELL ▼";
  const rr     = signal.tp2 && signal.sl
    ? (Math.abs(signal.tp2 - signal.price) / Math.abs(signal.price - signal.sl)).toFixed(1) : "~3";
  const now    = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short"
  });
  return `${emoji} <b>SMC SIGNAL — ${signal.symbol}</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>${dir}</b>
⏰ ${now}  |  TF: ${signal.timeframe}

💰 ENTRY  :  <code>${signal.price}</code>
🛑 SL     :  <code>${signal.sl}</code>
🎯 TP1    :  <code>${signal.tp1}</code>
🎯 TP2    :  <code>${signal.tp2}</code>
📊 RR     :  1:${rr}

📦 LOT    :  <b>${lotInfo.lot}</b>
💵 Risk   :  $${lotInfo.riskUSD}

${news}
━━━━━━━━━━━━━━━━━━━━
🤖 <b>AI ANALYSIS:</b>
${aiText}
━━━━━━━━━━━━━━━━━━━━
⚠️ <i>ไม่ใช่คำแนะนำการลงทุน</i>`;
}

app.post("/webhook", async (req, res) => {
  checkDailyReset();
  if (req.body.secret && req.body.secret !== C.SECRET) return res.status(401).json({ error: "Unauthorized" });
  const sig = req.body;
  if (!sig.signal || !sig.price) return res.status(400).json({ error: "Missing fields" });
  res.json({ ok: true });
  const maxLoss = C.ACCOUNT_USD * (C.MAX_LOSS_PCT / 100);
  if (state.dailyLoss >= maxLoss) {
    await sendTelegram(`⛔ <b>หยุดเทรดวันนี้!</b>\nถึง Max Daily Loss ${C.MAX_LOSS_PCT}%`);
    return;
  }
  try {
    const lotInfo = calcLot(sig.price, sig.sl, sig.symbol);
    const news    = await getNews();
    const aiText  = await analyzeGemini(sig, lotInfo, news);
    await sendTelegram(formatMsg(sig, lotInfo, aiText, news));
    state.signals++;
    state.lastSignal = { ...sig, sentAt: new Date().toISOString() };
  } catch (err) {
    await sendTelegram(`❌ Error: ${err.message}`);
  }
});

app.get("/test", async (req, res) => {
  const sym    = req.query.symbol || "XAUUSD";
  const side   = (req.query.side || "LONG").toUpperCase();
  const isLong = side === "LONG";
  const testSig = {
    signal: side, symbol: sym, timeframe: "M5",
    price:  sym.includes("XAU") ? 2345.50 : 1.0852,
    sl:     sym.includes("XAU") ? 2339.00 : (isLong ? 1.0820 : 1.0884),
    tp1:    sym.includes("XAU") ? 2358.50 : (isLong ? 1.0916 : 1.0788),
    tp2:    sym.includes("XAU") ? 2371.00 : (isLong ? 1.0980 : 1.0724),
  };
  const lotInfo = calcLot(testSig.price, testSig.sl, testSig.symbol);
  const news    = await getNews();
  const aiText  = await analyzeGemini(testSig, lotInfo, news);
  await sendTelegram(formatMsg(testSig, lotInfo, aiText, news));
  res.json({ status: "✅ Test sent!", signal: testSig });
});

app.get("/", (req, res) => {
  res.json({ status: "🚀 SMC Bot Running", signals: state.signals, lastSignal: state.lastSignal });
});

app.listen(C.PORT, () => console.log(`🚀 SMC Bot on :${C.PORT}`));
