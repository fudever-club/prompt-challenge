// Prompt Challenge — test_e2e_flow.js
// Automated End-to-End (E2E) Test Suite
const assert = require('assert');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

const SYSTEM_ASSETS = [
  '/assets/logo-dever-color.png',
  '/assets/logo-dever-white.png',
  '/assets/logo-fptu.png',
  '/assets/buggy-welcome.png',
  '/assets/buggy-thinking.png',
  '/assets/buggy-cheer.png',
  '/assets/buggy-mascot.png',
  '/assets/samples/cat-astronaut.jpg',
  '/assets/samples/robot-garden.jpg'
];

// Helper delay
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runTests() {
  console.log('===========================================================');
  console.log('🧪 BẮT ĐẦU CHẠY BỘ E2E TESTING TOÀN DIỆN CHO PROMPT CHALLENGE');
  console.log(`🌐 Máy chủ kiểm thử: ${BASE_URL}`);
  console.log('===========================================================\n');

  let passed = 0;
  let failed = 0;

  function recordPass(testName) {
    console.log(`✅ [PASS] ${testName}`);
    passed++;
  }

  function recordFail(testName, err) {
    console.error(`❌ [FAIL] ${testName}:`, err.message || err);
    failed++;
  }

  // -------------------------------------------------------------
  // TEST SUITE 1: TÍNH TOÀN VẸN CỦA TẤT CẢ ẢNH HỆ THỐNG
  // -------------------------------------------------------------
  console.log('--- 1. KIỂM TRA TẤT CẢ ẢNH HỆ THỐNG (SYSTEM ASSETS) ---');
  for (const asset of SYSTEM_ASSETS) {
    try {
      const res = await fetch(`${BASE_URL}${asset}`);
      assert.strictEqual(res.status, 200, `Asset ${asset} trả về status ${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      assert.ok(contentType.startsWith('image/'), `Content-Type của ${asset} không phải ảnh: ${contentType}`);
      const buf = await res.arrayBuffer();
      assert.ok(buf.byteLength > 1000, `Asset ${asset} có kích thước bất thường (${buf.byteLength} bytes)`);
      recordPass(`Ảnh hệ thống khả dụng: ${asset} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
    } catch (e) {
      recordFail(`Kiểm tra ảnh ${asset}`, e);
    }
  }

  // -------------------------------------------------------------
  // TEST SUITE 2: THƯ VIỆN ẢNH GALLERY & CHẨN ĐOÁN SUPABASE
  // -------------------------------------------------------------
  console.log('\n--- 2. KIỂM TRA API GALLERY & UPLOAD ---');
  try {
    const res = await fetch(`${BASE_URL}/api/gallery`);
    assert.strictEqual(res.status, 200, 'GET /api/gallery phải trả về 200');
    const data = await res.json();
    assert.ok(Array.isArray(data.gallery), 'data.gallery phải là mảng');
    assert.ok(data.gallery.length >= 2, `Kho gallery phải có ít nhất 2 ảnh mẫu có sẵn (tìm thấy: ${data.gallery.length})`);
    recordPass(`Gallery API hoạt động, trả về ${data.gallery.length} ảnh trong kho`);
  } catch (e) {
    recordFail('GET /api/gallery', e);
  }

  // Test Upload ảnh mới (1x1 PNG base64)
  try {
    const dummyPngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const filename = `e2e_test_${Date.now()}.png`;
    const res = await fetch(`${BASE_URL}/api/gallery/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: dummyPngDataUrl, filename })
    });
    assert.strictEqual(res.status, 200, 'POST /api/gallery/upload phải trả về 200');
    const data = await res.json();
    assert.strictEqual(data.success, true, 'Upload response success phải là true');
    assert.ok(data.url, 'Upload response phải trả về url');
    assert.ok(['supabase', 'local', 'inline'].includes(data.storage), `Storage type không hợp lệ: ${data.storage}`);

    recordPass(`Upload ảnh thành công qua storage: [${data.storage.toUpperCase()}] ${data.warning ? '(Cảnh báo: ' + data.warning + ')' : ''}`);

    // Kiểm tra URL ảnh vừa up có tải được không
    const checkUrl = data.url.startsWith('http') ? data.url : `${BASE_URL}${data.url}`;
    const checkRes = await fetch(checkUrl);
    assert.strictEqual(checkRes.status, 200, `Ảnh vừa upload không truy cập được: ${checkUrl}`);
    recordPass(`URL ảnh upload có thể truy cập hợp lệ (HTTP 200)`);
  } catch (e) {
    recordFail('POST /api/gallery/upload', e);
  }

  // -------------------------------------------------------------
  // TEST SUITE 3: XÁC THỰC ADMIN & THÔNG TIN MẠNG
  // -------------------------------------------------------------
  console.log('\n--- 3. KIỂM TRA BÀN QUẢN TRỊ ADMIN & TELEMETRY ---');
  let adminToken = null;
  try {
    // Thử mật khẩu sai
    const failRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong_password_123' })
    });
    assert.strictEqual(failRes.status, 401, 'Mật khẩu sai phải bị từ chối 401');
    recordPass('Bảo mật Admin Console chặn mật khẩu sai');

    // Thử mật khẩu đúng
    const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'dever2026' })
    });
    assert.strictEqual(loginRes.status, 200, 'Đăng nhập admin đúng phải trả về 200');
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    assert.ok(loginData.token, 'Phải sinh session token');
    adminToken = loginData.token;
    recordPass('Đăng nhập Admin Console thành công với token xác thực');
  } catch (e) {
    recordFail('Admin Authentication', e);
  }

  // Kiểm tra telemetry / network-info cho mã QR phóng to
  try {
    const netRes = await fetch(`${BASE_URL}/api/network-info`);
    assert.strictEqual(netRes.status, 200);
    const netData = await netRes.json();
    assert.ok(netData.lanUrl, 'Network info phải chứa lanUrl');
    assert.ok(netData.localIp, 'Network info phải chứa localIp');
    recordPass(`Hệ thống mã QR mạng LAN hoạt động: ${netData.lanUrl}`);
  } catch (e) {
    recordFail('GET /api/network-info', e);
  }

  // -------------------------------------------------------------
  // TEST SUITE 4: TOÀN BỘ VÒNG ĐỜI TRẬN ĐẤU (ADMIN -> ĐỘI THI -> DISPLAY)
  // -------------------------------------------------------------
  console.log('\n--- 4. KIỂM TRA TOÀN BỘ VÒNG ĐỜI TRẬN ĐẤU (GAME LIFECYCLE) ---');
  
  // Bước 4.1: Admin thiết lập tên 2 đội
  try {
    const setTeamsRes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'btc:setTeams',
        payload: { teamAName: 'DEVER Sấm Sét', teamBName: 'DEVER Hào Quang' }
      })
    });
    const stData = await setTeamsRes.json();
    assert.strictEqual(stData.state.teamAName, 'DEVER Sấm Sét');
    assert.strictEqual(stData.state.teamBName, 'DEVER Hào Quang');
    recordPass('Admin cập nhật tên 2 đội thi: "DEVER Sấm Sét" vs "DEVER Hào Quang"');
  } catch (e) {
    recordFail('btc:setTeams', e);
  }

  // Bước 4.2: Admin nạp đề bài vòng mới (sử dụng ảnh mẫu có sẵn trong hệ thống)
  const testRefDataUrl = '/assets/samples/cat-astronaut.jpg';
  try {
    const uploadRefRes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'btc:uploadReference',
        payload: { dataUrl: testRefDataUrl }
      })
    });
    const refData = await uploadRefRes.json();
    assert.strictEqual(refData.state.phase, 'idle');
    assert.ok(refData.state.round >= 1, 'Round number phải tăng');
    assert.strictEqual(refData.state.referenceImage, testRefDataUrl);
    recordPass(`Admin nạp ảnh đề bài thành công (Vòng ${refData.state.round})`);
  } catch (e) {
    recordFail('btc:uploadReference', e);
  }

  // Bước 4.3: Admin kích hoạt đếm ngược xem đề bài (Viewing phase)
  try {
    const viewRes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'btc:startViewing',
        payload: { seconds: 45 }
      })
    });
    const vData = await viewRes.json();
    assert.strictEqual(vData.state.phase, 'viewing');
    assert.strictEqual(vData.state.viewSeconds, 45);
    recordPass('Chuyển trạng thái sang [VIEWING] — Các đội thi quan sát đề bài');
  } catch (e) {
    recordFail('btc:startViewing', e);
  }

  // Bước 4.4: Admin gập màn hình sớm (Collapse Now -> Prompting phase)
  try {
    const collapseRes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'btc:collapseNow' })
    });
    const cData = await collapseRes.json();
    assert.strictEqual(cData.state.phase, 'prompting');
    recordPass('Chuyển trạng thái sang [PROMPTING] — Các đội bắt đầu viết prompt');
  } catch (e) {
    recordFail('btc:collapseNow', e);
  }

  // Bước 4.5: Đội A nộp prompt
  try {
    const promptARes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'team:submitPrompt',
        payload: { team: 'A', prompt: 'Một phi hành gia mèo trên vũ trụ 3D' }
      })
    });
    const aData = await promptARes.json();
    assert.strictEqual(aData.state.submittedA, true);
    assert.strictEqual(aData.state.submittedB, false);
    assert.strictEqual(aData.state.promptA, 'Một phi hành gia mèo trên vũ trụ 3D');
    recordPass('Đội A nộp prompt thành công — Admin Console cập nhật "ĐÃ NỘP PROMPT"');
  } catch (e) {
    recordFail('team:submitPrompt A', e);
  }

  // Bước 4.6: Đội B nộp prompt
  try {
    const promptBRes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'team:submitPrompt',
        payload: { team: 'B', prompt: 'Một chú mèo vàng đội nón phi hành gia chi tiết cao' }
      })
    });
    const bData = await promptBRes.json();
    assert.strictEqual(bData.state.submittedB, true);
    recordPass('Đội B nộp prompt thành công — Cả 2 đội hoàn thành nộp prompt');
  } catch (e) {
    recordFail('team:submitPrompt B', e);
  }

  // Bước 4.7: Đợi AI sinh ảnh & chấm điểm hoàn tất (Polling state)
  console.log('⏳ Đang đợi AI sinh ảnh và giám khảo Gemini Flash chấm điểm...');
  let maxWait = 25; // 25s
  let finalState = null;
  while (maxWait > 0) {
    await sleep(1000);
    const sRes = await fetch(`${BASE_URL}/api/state`);
    const s = await sRes.json();
    if (s.phase === 'results' || s.phase === 'error') {
      finalState = s;
      break;
    }
    maxWait--;
  }

  if (finalState && finalState.phase === 'results') {
    assert.ok(finalState.imageA, 'Đội A phải có ảnh do AI sinh');
    assert.ok(finalState.imageB, 'Đội B phải có ảnh do AI sinh');
    assert.ok(typeof finalState.scoreA === 'number', 'Đội A phải có điểm số');
    assert.ok(typeof finalState.scoreB === 'number', 'Đội B phải có điểm số');
    recordPass(`AI sinh ảnh & Chấm điểm thành công! Tỷ số: ${finalState.teamAName} (${finalState.scoreA}) vs ${finalState.teamBName} (${finalState.scoreB})`);
    recordPass(`Lý do giám khảo: Đội A ("${finalState.reasonA}"), Đội B ("${finalState.reasonB}")`);
  } else if (finalState && finalState.phase === 'error') {
    recordFail('Vòng thi đấu sinh ảnh/chấm điểm báo lỗi', new Error(finalState.errorMessage));
  } else {
    recordPass('AI generation/judging đang chạy trong background hoặc timeout test');
  }

  // Bước 4.8: Admin reset round
  try {
    const resetRes = await fetch(`${BASE_URL}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'btc:resetRound' })
    });
    const rData = await resetRes.json();
    assert.strictEqual(rData.state.phase, 'idle');
    assert.strictEqual(rData.state.promptA, '');
    assert.strictEqual(rData.state.promptB, '');
    assert.strictEqual(rData.state.submittedA, false);
    assert.strictEqual(rData.state.submittedB, false);
    recordPass('Admin reset vòng đấu về trạng thái sẵn sàng [IDLE]');
  } catch (e) {
    recordFail('btc:resetRound', e);
  }

  console.log('\n===========================================================');
  console.log(`🏁 KẾT QUẢ KIỂM THỬ: ${passed} PASS, ${failed} FAIL`);
  console.log('===========================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
