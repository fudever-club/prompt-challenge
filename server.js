// Prompt Challenge — server.js
// Chạy: node server.js  (cần Node 18+)
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20 * 1024 * 1024 }); // cho phép ảnh base64 lớn

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const DEFAULT_JUDGE_PROMPT = `Bạn là giám khảo cuộc thi "Prompt Challenge". Bạn sẽ nhận 1 ảnh gốc (reference) và ảnh do 1 đội tạo ra từ prompt của họ.
Chấm điểm mức độ GIỐNG NHAU giữa 2 ảnh trên thang 1-5 sao (có thể lẻ 0.5), dựa trên: chủ thể chính, bố cục, màu sắc/phong cách, chi tiết phụ.
Trả lời CHỈ bằng JSON, không thêm chữ nào khác, đúng format:
{"score": <số 1-5>, "reason": "<1 câu ngắn giải thích bằng tiếng Việt>"}`;

// ---- Trạng thái ván chơi (in-memory, dùng chung cho mọi màn hình qua socket) ----
let state = {
  phase: 'idle', // idle | viewing | prompting | generating | judging | results
  round: 0,
  teamAName: 'Đội A',
  teamBName: 'Đội B',
  referenceImage: null, // base64
  viewSeconds: 60,
  secondsLeft: 0,
  promptA: '', promptB: '',
  submittedA: false, submittedB: false,
  imageA: null, imageB: null,
  scoreA: null, scoreB: null,
  reasonA: '', reasonB: '',
  judgeSystemPrompt: DEFAULT_JUDGE_PROMPT,
};

let leaderboard = {}; // { teamName: { totalScore, rounds } }
let timer = null;

function broadcastState() {
  io.emit('state', state);
}
function broadcastLeaderboard() {
  io.emit('leaderboard', leaderboard);
}

function addToLeaderboard(name, score) {
  if (!name) return;
  if (!leaderboard[name]) leaderboard[name] = { totalScore: 0, rounds: 0 };
  leaderboard[name].totalScore += score;
  leaderboard[name].rounds += 1;
}

function clearTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- Gọi API tạo ảnh từ prompt ----
// Ưu tiên Nano Banana (Gemini 2.5 Flash Image), fallback OpenAI nếu không có Gemini
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare';

async function generateImage(prompt) {
  if (GEMINI_API_KEY) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE']
        }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Nano Banana API lỗi (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!imgPart) throw new Error('Nano Banana không trả về dữ liệu ảnh.');
    const mime = imgPart.inlineData.mimeType || 'image/png';
    return `data:${mime};base64,${imgPart.inlineData.data}`;
  }

  if (!OPENAI_API_KEY) {
    throw new Error('Thiếu GEMINI_API_KEY hoặc OPENAI_API_KEY trong .env — xem README để cấu hình.');
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size: '1024x1024',
      n: 1,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Image API lỗi (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const item = data.data?.[0];
  if (!item) throw new Error('Image API không trả về dữ liệu ảnh.');

  if (item.b64_json) {
    return `data:image/png;base64,${item.b64_json}`;
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    const arrayBuffer = await imgRes.arrayBuffer();
    const b64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:image/png;base64,${b64}`;
  }

  throw new Error('Không tìm thấy dữ liệu ảnh (b64_json hoặc url) từ Image API.');
}

// ---- Chấm điểm (so sánh ảnh gốc vs ảnh đội gửi) ----
// Ưu tiên Gemini Flash, fallback Claude (Anthropic)
async function judgeImage(referenceImageDataUrl, submittedImageDataUrl, systemPrompt) {
  if (GEMINI_API_KEY) {
    const parseDataUrl = (d) => {
      const m = (d || '').match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) return { mimeType: m[1], data: m[2] };
      return { mimeType: 'image/png', data: (d || '').replace(/^data:image\/\w+;base64,/, '') };
    };
    const ref = parseDataUrl(referenceImageDataUrl);
    const sub = parseDataUrl(submittedImageDataUrl);

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `${systemPrompt}\n\nẢnh 1 là ảnh gốc (reference), ảnh 2 là ảnh do đội chơi tạo ra từ prompt.` },
              { inlineData: { mimeType: ref.mimeType, data: ref.data } },
              { inlineData: { mimeType: sub.mimeType, data: sub.data } }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Judge API lỗi (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((c) => c.text || '').join('').trim();
    const cleaned = text.replace(/```json|```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      return { score: Number(parsed.score) || 0, reason: parsed.reason || '' };
    } catch {
      return { score: 0, reason: 'Không đọc được kết quả chấm điểm từ Gemini.' };
    }
  }

  if (!ANTHROPIC_API_KEY) {
    throw new Error('Thiếu GEMINI_API_KEY hoặc ANTHROPIC_API_KEY trong .env để chấm điểm.');
  }
  const stripPrefix = (d) => d.replace(/^data:image\/\w+;base64,/, '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Ảnh gốc (reference):' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: stripPrefix(referenceImageDataUrl) } },
            { type: 'text', text: 'Ảnh đội gửi:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: stripPrefix(submittedImageDataUrl) } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Judge API lỗi (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return { score: Number(parsed.score) || 0, reason: parsed.reason || '' };
  } catch {
    return { score: 0, reason: 'Không đọc được kết quả chấm điểm.' };
  }
}

// ---- Chạy vòng sinh ảnh + chấm điểm khi cả 2 đội đã gửi prompt ----
async function runGenerationAndJudging() {
  state.phase = 'generating';
  broadcastState();
  try {
    const [imageA, imageB] = await Promise.all([
      generateImage(state.promptA),
      generateImage(state.promptB),
    ]);
    state.imageA = imageA;
    state.imageB = imageB;

    state.phase = 'judging';
    broadcastState();

    const [judgedA, judgedB] = await Promise.all([
      judgeImage(state.referenceImage, imageA, state.judgeSystemPrompt),
      judgeImage(state.referenceImage, imageB, state.judgeSystemPrompt),
    ]);
    state.scoreA = judgedA.score;
    state.reasonA = judgedA.reason;
    state.scoreB = judgedB.score;
    state.reasonB = judgedB.reason;

    addToLeaderboard(state.teamAName, judgedA.score);
    addToLeaderboard(state.teamBName, judgedB.score);

    state.phase = 'results';
    broadcastState();
    broadcastLeaderboard();
  } catch (err) {
    state.phase = 'error';
    state.errorMessage = err.message;
    broadcastState();
  }
}

// ---- Socket events (điều khiển từ trang BTC) ----
io.on('connection', (socket) => {
  socket.emit('state', state);
  socket.emit('leaderboard', leaderboard);

  socket.on('btc:setTeams', ({ teamAName, teamBName }) => {
    state.teamAName = teamAName || 'Đội A';
    state.teamBName = teamBName || 'Đội B';
    broadcastState();
  });

  socket.on('btc:setJudgePrompt', (prompt) => {
    state.judgeSystemPrompt = prompt || DEFAULT_JUDGE_PROMPT;
    broadcastState();
  });

  socket.on('btc:uploadReference', (dataUrl) => {
    clearTimer();
    state = {
      ...state,
      phase: 'idle',
      round: state.round + 1,
      referenceImage: dataUrl,
      promptA: '', promptB: '',
      submittedA: false, submittedB: false,
      imageA: null, imageB: null,
      scoreA: null, scoreB: null,
      reasonA: '', reasonB: '',
    };
    broadcastState();
  });

  socket.on('btc:startViewing', (seconds) => {
    clearTimer();
    state.phase = 'viewing';
    state.viewSeconds = seconds || 60;
    state.secondsLeft = state.viewSeconds;
    broadcastState();
    timer = setInterval(() => {
      state.secondsLeft -= 1;
      if (state.secondsLeft <= 0) {
        clearTimer();
        state.phase = 'prompting';
      }
      broadcastState();
    }, 1000);
  });

  // "Gập xuống" — BTC kết thúc thời gian xem ảnh sớm
  socket.on('btc:collapseNow', () => {
    clearTimer();
    state.phase = 'prompting';
    broadcastState();
  });

  socket.on('team:submitPrompt', ({ team, prompt }) => {
    if (state.phase !== 'prompting') return;
    if (team === 'A' && !state.submittedA) {
      state.promptA = prompt;
      state.submittedA = true;
    } else if (team === 'B' && !state.submittedB) {
      state.promptB = prompt;
      state.submittedB = true;
    }
    broadcastState();
    if (state.submittedA && state.submittedB) {
      runGenerationAndJudging();
    }
  });

  // BTC ép chạy dù 1 đội chưa gửi (vd hết giờ chờ)
  socket.on('btc:forceGenerate', () => {
    if (state.phase !== 'prompting') return;
    if (!state.submittedA) { state.promptA = state.promptA || '(không gửi prompt)'; state.submittedA = true; }
    if (!state.submittedB) { state.promptB = state.promptB || '(không gửi prompt)'; state.submittedB = true; }
    runGenerationAndJudging();
  });

  socket.on('btc:resetRound', () => {
    clearTimer();
    state.phase = 'idle';
    state.referenceImage = null;
    state.promptA = ''; state.promptB = '';
    state.submittedA = false; state.submittedB = false;
    state.imageA = null; state.imageB = null;
    state.scoreA = null; state.scoreB = null;
    state.reasonA = ''; state.reasonB = '';
    broadcastState();
  });

  socket.on('btc:resetLeaderboard', () => {
    leaderboard = {};
    broadcastLeaderboard();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Prompt Challenge server chạy tại http://localhost:${PORT}`);
  console.log(`  - BTC:      http://localhost:${PORT}/btc.html`);
  console.log(`  - Đội A:    http://localhost:${PORT}/team.html?team=A`);
  console.log(`  - Đội B:    http://localhost:${PORT}/team.html?team=B`);
  console.log(`  - Màn hình: http://localhost:${PORT}/display.html`);
});
