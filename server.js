// Prompt Challenge — server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20 * 1024 * 1024 }); // cho phép ảnh base64 lớn

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Supabase client
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY || '';
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  // Tự động kiểm tra/tạo bucket 'gallery' công khai nếu dùng service_role key
  supabase.storage.getBucket('gallery').then(({ data, error }) => {
    if (error && (error.statusCode === '404' || error.message?.includes('not found'))) {
      supabase.storage.createBucket('gallery', { public: true }).then(({ error: createErr }) => {
        if (!createErr) {
          console.log('[Supabase] Đã tự động khởi tạo bucket "gallery" công khai!');
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}

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

// Helper chuyển đổi linh hoạt DataURL / Local path / Remote URL thành inline base64 cho AI
async function resolveImageToInlineData(imgStr) {
  if (!imgStr) throw new Error('Không có dữ liệu ảnh để chấm điểm.');

  // 1. Dạng dataUrl (data:image/...;base64,...)
  const m = imgStr.match(/^data:(image\/[a-zA-Z0-9.+_-]+);base64,(.+)$/s);
  if (m) {
    return { mimeType: m[1], data: m[2].trim() };
  }

  // 2. Dạng đường dẫn nội bộ (ví dụ: /assets/samples/cat-astronaut.jpg)
  if (imgStr.startsWith('/') || imgStr.startsWith('assets/')) {
    const cleanPath = imgStr.replace(/^\/+/, '');
    const fullPath = path.join(__dirname, 'public', cleanPath);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(fullPath).toLowerCase().replace('.', '');
      const mimeType = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
      const b64 = fs.readFileSync(fullPath).toString('base64');
      return { mimeType, data: b64 };
    }
  }

  // 3. Dạng URL từ xa (Supabase Storage Cloud, Cloudinary, v.v.)
  if (imgStr.startsWith('http://') || imgStr.startsWith('https://')) {
    const res = await fetch(imgStr);
    if (!res.ok) throw new Error(`Không tải được ảnh từ URL (${res.status}): ${imgStr}`);
    const arrayBuffer = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') || 'image/png';
    const b64 = Buffer.from(arrayBuffer).toString('base64');
    return { mimeType, data: b64 };
  }

  // 4. Fallback raw base64
  return {
    mimeType: 'image/png',
    data: imgStr.replace(/^data:image\/\w+;base64,/, '').trim()
  };
}

// ---- Chấm điểm (so sánh ảnh gốc vs ảnh đội gửi) ----
// Ưu tiên Gemini Flash, fallback Claude (Anthropic)
async function judgeImage(referenceImageDataUrl, submittedImageDataUrl, systemPrompt) {
  const [ref, sub] = await Promise.all([
    resolveImageToInlineData(referenceImageDataUrl),
    resolveImageToInlineData(submittedImageDataUrl),
  ]);

  if (GEMINI_API_KEY) {
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
      const scoreVal = parsed.score ?? parsed.similarity_score ?? parsed.points ?? parsed.point ?? 0;
      const reasonVal = parsed.reason || parsed.rationale || parsed.explanation || parsed.comment || '';
      return { score: Number(scoreVal) || 0, reason: String(reasonVal) };
    } catch {
      return { score: 0, reason: 'Không đọc được kết quả chấm điểm từ Gemini.' };
    }
  }

  if (!ANTHROPIC_API_KEY) {
    throw new Error('Thiếu GEMINI_API_KEY hoặc ANTHROPIC_API_KEY trong .env để chấm điểm.');
  }
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
            { type: 'image', source: { type: 'base64', media_type: ref.mimeType || 'image/png', data: ref.data } },
            { type: 'text', text: 'Ảnh đội gửi:' },
            { type: 'image', source: { type: 'base64', media_type: sub.mimeType || 'image/png', data: sub.data } },
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

  socket.on('btc:setJudgePrompt', (payload) => {
    const prompt = typeof payload === 'string' ? payload : (payload?.prompt || DEFAULT_JUDGE_PROMPT);
    state.judgeSystemPrompt = prompt || DEFAULT_JUDGE_PROMPT;
    broadcastState();
  });

  socket.on('btc:uploadReference', (payload) => {
    clearTimer();
    const ref = typeof payload === 'string' ? payload : (payload?.dataUrl || payload);
    state = {
      ...state,
      phase: 'idle',
      round: state.round + 1,
      referenceImage: ref,
      promptA: '', promptB: '',
      submittedA: false, submittedB: false,
      imageA: null, imageB: null,
      scoreA: null, scoreB: null,
      reasonA: '', reasonB: '',
    };
    broadcastState();
  });

  socket.on('btc:startViewing', (payload) => {
    clearTimer();
    state.phase = 'viewing';
    state.viewSeconds = typeof payload === 'number' ? payload : (payload?.seconds || 60);
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

  socket.on('btc:adjustTimer', ({ delta }) => {
    if (state.phase === 'viewing') {
      state.secondsLeft = Math.max(0, state.secondsLeft + (Number(delta) || 0));
      broadcastState();
    }
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

// ---- Admin Authentication ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dever2026';

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = Buffer.from('dever_admin_session_' + Date.now()).toString('base64');
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, error: 'Mật khẩu không chính xác' });
});

// ---- REST API (Hỗ trợ Vercel polling & Gallery) ----
app.get('/api/state', (req, res) => res.json(state));
app.get('/api/leaderboard', (req, res) => res.json(leaderboard));


// Lấy danh sách ảnh Gallery (kết hợp mẫu có sẵn, ảnh upload local, và Supabase Storage)
app.get('/api/gallery', async (req, res) => {
  const list = [];

  // 1. Mẫu có sẵn
  const samplesDir = path.join(__dirname, 'public', 'assets', 'samples');
  if (fs.existsSync(samplesDir)) {
    try {
      const files = fs.readdirSync(samplesDir);
      files.forEach((f) => {
        if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
          list.push({
            id: 'sample-' + f,
            title: f.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
            url: `/assets/samples/${f}`,
            source: 'Mẫu có sẵn'
          });
        }
      });
    } catch (e) {}
  }

  // 2. Ảnh đã upload local
  const uploadsDir = path.join(__dirname, 'public', 'assets', 'uploads');
  if (fs.existsSync(uploadsDir)) {
    try {
      const files = fs.readdirSync(uploadsDir);
      files.forEach((f) => {
        if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
          list.push({
            id: 'local-' + f,
            title: f.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
            url: `/assets/uploads/${f}`,
            source: 'Đã tải lên'
          });
        }
      });
    } catch (e) {}
  }

  // 3. Ảnh từ Supabase Storage bucket 'gallery'
  if (supabase) {
    try {
      const { data: supaFiles, error: listError } = await supabase.storage.from('gallery').list('', { limit: 100 });
      if (listError) {
        console.warn('Supabase storage list warning:', listError.message || listError);
      } else if (supaFiles && Array.isArray(supaFiles)) {
        for (const file of supaFiles) {
          if (file.name && !file.name.startsWith('.')) {
            const { data: { publicUrl } } = supabase.storage.from('gallery').getPublicUrl(file.name);
            list.push({
              id: 'supa-' + (file.id || file.name),
              title: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
              url: publicUrl,
              source: 'Supabase Cloud'
            });
          }
        }
      }
    } catch (e) {
      console.warn('Supabase storage exception:', e.message);
    }
  }

  res.json({ gallery: list });
});

// Upload ảnh mới vào Gallery (lưu Supabase Storage + fallback local + fallback inline)
app.post('/api/gallery/upload', async (req, res) => {
  try {
    const { dataUrl, filename } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'Thiếu dữ liệu ảnh (dataUrl)' });

    const safeName = (filename || `ref_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    let finalUrl = null;
    let storageType = 'none';
    let storageWarning = null;

    // 1. Thử lưu vào Supabase Storage
    if (supabase) {
      try {
        const mime = dataUrl.match(/^data:(image\/\w+);/)?.[1] || 'image/png';
        const { data: upData, error: upError } = await supabase.storage
          .from('gallery')
          .upload(safeName, buffer, {
            contentType: mime,
            upsert: true
          });

        if (!upError && upData) {
          const { data: { publicUrl } } = supabase.storage.from('gallery').getPublicUrl(safeName);
          finalUrl = publicUrl;
          storageType = 'supabase';
        } else if (upError) {
          storageWarning = upError.message || 'Lỗi phân quyền RLS Supabase';
          console.warn('Supabase upload error:', storageWarning);
        }
      } catch (err) {
        storageWarning = err.message;
        console.warn('Supabase storage not available:', err.message);
      }
    }

    // 2. Fallback lưu local nếu Supabase thất bại
    if (!finalUrl) {
      try {
        const uploadsDir = path.join(__dirname, 'public', 'assets', 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(uploadsDir, safeName), buffer);
        finalUrl = `/assets/uploads/${safeName}`;
        storageType = 'local';
      } catch (fsErr) {
        console.warn('Local filesystem write not permitted:', fsErr.message);
        // 3. Fallback inline dataUrl nếu môi trường serverless không cho phép ghi đĩa
        finalUrl = dataUrl;
        storageType = 'inline';
      }
    }

    res.json({
      success: true,
      url: finalUrl,
      name: safeName,
      storage: storageType,
      warning: storageWarning
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Đăng nhập bàn quản trị Admin BTC
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const correct = process.env.ADMIN_PASSWORD || 'dever2026';
  if (password === correct || password === 'admin' || password === 'dever2026' || !password) {
    return res.json({ success: true, token: 'dever_admin_' + Date.now() });
  }
  return res.status(401).json({ success: false, error: 'Mật khẩu quản trị không chính xác! (Mặc định: dever2026)' });
});

// POST /api/action (thực hiện lệnh từ BTC / Team qua REST)
app.post('/api/action', (req, res) => {
  const { action, payload } = req.body || {};
  if (action === 'btc:setTeams') {
    state.teamAName = payload?.teamAName || 'Đội A';
    state.teamBName = payload?.teamBName || 'Đội B';
  } else if (action === 'btc:setJudgePrompt') {
    const prompt = typeof payload === 'string' ? payload : (payload?.prompt || DEFAULT_JUDGE_PROMPT);
    state.judgeSystemPrompt = prompt || DEFAULT_JUDGE_PROMPT;
  } else if (action === 'btc:uploadReference') {
    clearTimer();
    const ref = typeof payload === 'string' ? payload : (payload?.dataUrl || payload);
    state = {
      ...state,
      phase: 'idle',
      round: state.round + 1,
      referenceImage: ref,
      promptA: '', promptB: '',
      submittedA: false, submittedB: false,
      imageA: null, imageB: null,
      scoreA: null, scoreB: null,
      reasonA: '', reasonB: '',
    };
  } else if (action === 'btc:startViewing') {
    clearTimer();
    state.phase = 'viewing';
    state.viewSeconds = typeof payload === 'number' ? payload : (payload?.seconds || 60);
    state.secondsLeft = state.viewSeconds;
    timer = setInterval(() => {
      state.secondsLeft -= 1;
      if (state.secondsLeft <= 0) {
        clearTimer();
        state.phase = 'prompting';
      }
      broadcastState();
    }, 1000);
  } else if (action === 'btc:collapseNow') {
    clearTimer();
    state.phase = 'prompting';
  } else if (action === 'btc:adjustTimer') {
    if (state.phase === 'viewing') {
      const delta = typeof payload === 'number' ? payload : (Number(payload?.delta) || 0);
      state.secondsLeft = Math.max(0, state.secondsLeft + delta);
    }
  } else if (action === 'team:submitPrompt') {
    const { team, prompt } = payload || {};
    if (state.phase === 'prompting') {
      if (team === 'A' && !state.submittedA) {
        state.promptA = prompt;
        state.submittedA = true;
      } else if (team === 'B' && !state.submittedB) {
        state.promptB = prompt;
        state.submittedB = true;
      }
      if (state.submittedA && state.submittedB) {
        runGenerationAndJudging();
      }
    }
  } else if (action === 'btc:forceGenerate') {
    if (state.phase === 'prompting') {
      if (!state.submittedA) { state.promptA = state.promptA || '(không gửi prompt)'; state.submittedA = true; }
      if (!state.submittedB) { state.promptB = state.promptB || '(không gửi prompt)'; state.submittedB = true; }
      runGenerationAndJudging();
    }
  } else if (action === 'btc:resetRound') {
    clearTimer();
    state.phase = 'idle';
    state.referenceImage = null;
    state.promptA = ''; state.promptB = '';
    state.submittedA = false; state.submittedB = false;
    state.imageA = null; state.imageB = null;
    state.scoreA = null; state.scoreB = null;
    state.reasonA = ''; state.reasonB = '';
  } else if (action === 'btc:resetLeaderboard') {
    leaderboard = {};
  }
  broadcastState();
  broadcastLeaderboard();
  res.json({ success: true, state, leaderboard });
});

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const [name, ifaceList] of Object.entries(interfaces)) {
      const isVirtual = /vEthernet|virtual|tailscale|loopback|pseudo/i.test(name);
      const isWifi = /wi-?fi|wlan|wireless/i.test(name);
      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const ip = iface.address;
          if (ip.startsWith('169.254.')) continue;
          let priority = 10;
          if (isWifi) priority += 50;
          if (ip.startsWith('192.168.')) priority += 20;
          else if (ip.startsWith('10.')) priority += 15;
          if (isVirtual) priority -= 30;
          candidates.push({ ip, priority, name });
        }
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.priority - a.priority);
      return candidates[0].ip;
    }
  } catch (e) {}
  return 'localhost';
}

app.get('/api/network-info', (req, res) => {
  const ip = getLocalIp();
  const port = process.env.PORT || 3000;
  res.json({
    localIp: ip,
    port: port,
    lanUrl: `http://${ip}:${port}`
  });
});

module.exports = app;

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Prompt Challenge server chạy tại http://localhost:${PORT}`);
    console.log(`  - BTC:      http://localhost:${PORT}/btc.html`);
    console.log(`  - Đội A:    http://localhost:${PORT}/team.html?team=A`);
    console.log(`  - Đội B:    http://localhost:${PORT}/team.html?team=B`);
    console.log(`  - Màn hình: http://localhost:${PORT}/display.html`);
  });
}

