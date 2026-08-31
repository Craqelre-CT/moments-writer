/* ==================================================
   朋友圈文案助手 · 主逻辑
   - Tab 切换
   - 图片上传 + base64
   - OpenAI 兼容 Vision 识别
   - OpenAI 兼容 Chat 生成文案
   - 用户画像问答
   - 今日规划（localStorage）
   ================================================== */

'use strict';

/* ---------- 工具函数 ---------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LS = {
  CFG: 'moments_cfg',
  PROFILE: 'moments_profile',
  PLAN_PREFIX: 'moments_plan_',
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeGet(key, def) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : def;
  } catch (e) { return def; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function showLoading(text = 'AI 正在思考中...') {
  $('#loadingText').textContent = text;
  $('#loadingMask').hidden = false;
}
function hideLoading() { $('#loadingMask').hidden = true; }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ==================================================
   配置
   ================================================== */
const DEFAULT_CFG = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  visionModel: 'gpt-4o-mini',
  textModel: 'gpt-4o-mini',
};

let cfg = { ...DEFAULT_CFG, ...safeGet(LS.CFG, {}) };

function loadCfgToUI() {
  $('#cfgBaseUrl').value    = cfg.baseUrl || '';
  $('#cfgApiKey').value     = cfg.apiKey || '';
  $('#cfgVisionModel').value = cfg.visionModel || '';
  $('#cfgTextModel').value   = cfg.textModel || '';
}

function saveCfgFromUI() {
  cfg.baseUrl     = $('#cfgBaseUrl').value.trim() || DEFAULT_CFG.baseUrl;
  cfg.apiKey      = $('#cfgApiKey').value.trim();
  cfg.visionModel = $('#cfgVisionModel').value.trim() || DEFAULT_CFG.visionModel;
  cfg.textModel   = $('#cfgTextModel').value.trim() || DEFAULT_CFG.textModel;
  safeSet(LS.CFG, cfg);
  toast('✅ 配置已保存');
}

async function testCfg() {
  if (!cfg.apiKey) { toast('⚠️ 请先填写 API Key'); return; }
  showLoading('正在测试连接...');
  try {
    const data = await callChat([
      { role: 'user', content: '请回复"连接成功"四个字。' }
    ], cfg.textModel, 60, 0);
    hideLoading();
    const text = extractText(data);
    $('#cfgStatus').textContent = '✅ ' + text;
    toast('连接成功');
  } catch (e) {
    hideLoading();
    $('#cfgStatus').textContent = '❌ ' + (e.message || '连接失败');
    toast('连接失败');
  }
}

/* ==================================================
   AI 请求
   ================================================== */
function normalizeBase(url) {
  if (!url) return 'https://api.openai.com/v1';
  return url.replace(/\/+$/, '');
}

async function callChat(messages, model, maxTokens = 1200, temperature = 0.7) {
  const url = normalizeBase(cfg.baseUrl) + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (cfg.apiKey || ''),
    },
    body: JSON.stringify({
      model: model || cfg.textModel,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const errJson = await resp.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch (_) { detail = await resp.text(); }
    throw new Error(`[${resp.status}] ${detail || resp.statusText}`);
  }
  return await resp.json();
}

function extractText(json) {
  try {
    return json.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) { return ''; }
}

// 图像识别（Vision）
async function recognizeImage(base64DataUrl) {
  const url = normalizeBase(cfg.baseUrl) + '/chat/completions';
  const prompt = `请用中文分析这张图片，输出以下信息：
1. 【主体】画面里的主要物体/人物/场景是什么；
2. 【氛围】整体氛围、情绪和风格（例如：温馨、活泼、文艺、商务、高级感、烟火气等）；
3. 【细节】值得关注的细节元素、颜色、构图；
4. 【场景推断】这张图片可能拍摄于什么场景下（如：旅行、约会、工作、聚餐、生活随拍等）。
请用简洁的中文分点回答，便于后续生成朋友圈文案。`;

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: base64DataUrl, detail: 'low' } },
      ],
    },
  ];

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (cfg.apiKey || ''),
    },
    body: JSON.stringify({
      model: cfg.visionModel,
      messages,
      max_tokens: 600,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try { const ej = await resp.json(); detail = ej?.error?.message || JSON.stringify(ej); }
    catch (_) { detail = await resp.text(); }
    throw new Error(`[${resp.status}] ${detail || resp.statusText}`);
  }
  const json = await resp.json();
  return extractText(json);
}

/* ==================================================
   用户画像
   ================================================== */
const QA_QUESTIONS = [
  {
    q: '你的性别是？',
    opts: ['女生', '男生', '不透露'],
    field: 'gender',
  },
  {
    q: '你大概的年龄段是？',
    opts: ['学生 / 20岁以下', '20-28岁', '29-35岁', '36岁以上'],
    field: 'ageRange',
  },
  {
    q: '你目前的职业或主要身份是？',
    opts: ['学生', '互联网/科技从业者', '设计师/艺术家', '教师/医务/公务员', '自由职业/创业者', '全职爸妈', '其他'],
    field: 'career',
  },
  {
    q: '你朋友圈的主要受众是？',
    opts: ['朋友 / 同学', '同事 / 职场人脉', '家人亲戚', '混合人群', '粉丝/公开账号'],
    field: 'audience',
  },
  {
    q: '你平时发朋友圈的文风偏好是？',
    opts: ['文艺走心', '活泼搞笑', '简洁直接', '高级感 / 冷淡风', '正能量鸡汤', '专业 / 知识分享'],
    field: 'style',
  },
  {
    q: '你更喜欢带 hashtag（#话题）吗？',
    opts: ['常用，多带几个', '偶尔 1-2 个', '几乎不用'],
    field: 'hashtag',
  },
  {
    q: '你常用的表情符号频率是？',
    opts: ['大量 emoji 🌞✨', '偶尔点缀', '几乎不用'],
    field: 'emoji',
  },
  {
    q: '你最常发哪些主题的朋友圈？（可选）',
    opts: ['旅行 / 风景', '美食 / 探店', '日常 / 生活记录', '宠物 / 萌娃', '工作 / 学习', '健身 / 运动', '读书 / 观影'],
    field: 'topics',
    multi: true,
  },
];

let profile = safeGet(LS.PROFILE, null);
let qaStep = -1;           // -1 表示未开始
let qaAnswers = {};

function startQA() {
  qaStep = -1;
  qaAnswers = {};
  renderQA();
}

function renderQA() {
  const flow = $('#qaFlow');
  flow.innerHTML = '';

  // 渲染已完成的问答（以结果卡片形式展示）
  const done = QA_QUESTIONS.slice(0, qaStep + 1);
  done.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'qa-card';
    const ans = qaAnswers[item.field];
    const ansText = Array.isArray(ans) ? ans.join('、') : (ans || '（未填写）');
    card.innerHTML = `
      <div class="qa-question"><span class="q-num">Q${i + 1}</span>${item.q}</div>
      <div class="qa-answer"><strong>我的回答：</strong>${ansText}</div>
    `;
    flow.appendChild(card);
  });

  // 当前问题
  if (qaStep + 1 < QA_QUESTIONS.length) {
    const next = QA_QUESTIONS[qaStep + 1];
    const cur = document.createElement('div');
    cur.className = 'qa-card';
    const optHtml = (next.opts || []).map(o => `<button class="qa-opt" data-val="${o}">${o}</button>`).join('');
    cur.innerHTML = `
      <div class="qa-question"><span class="q-num">Q${qaStep + 2}</span>${next.q}</div>
      <div class="qa-options">${optHtml}</div>
      ${next.multi ? `<input class="qa-free" placeholder="也可在下方自由补充说明（可选）" />` : `<input class="qa-free" placeholder="自由输入其他答案（可选，选填后覆盖选项）" />`}
      <div class="action-row">
        ${next.multi
          ? `<button class="btn btn-primary" id="qaNext">确认并继续</button>`
          : `<button class="btn btn-primary" id="qaNext" disabled>确认并继续</button>`}
        <button class="btn btn-ghost" id="qaSkip">跳过此题</button>
      </div>
    `;
    flow.appendChild(cur);

    const selected = new Set();
    const opts = cur.querySelectorAll('.qa-opt');
    const nextBtn = cur.querySelector('#qaNext');
    const freeInput = cur.querySelector('.qa-free');

    opts.forEach(btn => {
      btn.addEventListener('click', () => {
        if (next.multi) {
          if (selected.has(btn.dataset.val)) {
            selected.delete(btn.dataset.val);
            btn.classList.remove('selected');
          } else {
            selected.add(btn.dataset.val);
            btn.classList.add('selected');
          }
          nextBtn.disabled = false;
        } else {
          opts.forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          qaAnswers[next.field] = btn.dataset.val;
          nextBtn.disabled = false;
        }
      });
    });

    freeInput.addEventListener('input', () => {
      if (!next.multi) {
        nextBtn.disabled = !freeInput.value.trim() && selected.size === 0;
      }
    });

    nextBtn.addEventListener('click', () => {
      if (next.multi) {
        const multi = [...selected];
        if (freeInput.value.trim()) multi.push(freeInput.value.trim());
        qaAnswers[next.field] = multi.length ? multi : ['无特别偏好'];
      } else {
        if (freeInput.value.trim()) qaAnswers[next.field] = freeInput.value.trim();
      }
      qaStep++;
      renderQA();
      refreshProfilePreview();
    });

    cur.querySelector('#qaSkip').addEventListener('click', () => {
      qaAnswers[next.field] = next.multi ? ['无特别偏好'] : '无';
      qaStep++;
      renderQA();
      refreshProfilePreview();
    });
  } else {
    // 全部完成
    const summary = document.createElement('div');
    summary.className = 'qa-summary';
    summary.innerHTML = `
      <div class="qa-summary-title">🎉 画像构建完成！</div>
      <div style="font-size:13.5px;color:var(--c-text-soft);line-height:1.8">
        AI 会根据以上信息为你生成更贴合个人风格的朋友圈文案。你也可以点击下方按钮重新开始问答，或直接在画像中手动编辑。
      </div>
      <div class="action-row">
        <button class="btn btn-primary" id="qaSave">💾 保存为我的用户画像</button>
      </div>
    `;
    flow.appendChild(summary);
    summary.querySelector('#qaSave').addEventListener('click', () => {
      profile = { ...qaAnswers, savedAt: Date.now() };
      safeSet(LS.PROFILE, profile);
      toast('✅ 用户画像已保存');
      refreshProfilePreview();
    });
  }

  refreshProfilePreview();
}

function refreshProfilePreview() {
  const box = $('#profilePreview');
  const text = $('#profileText');
  const data = profile || qaAnswers;
  if (!data || Object.keys(data).length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const lines = Object.entries(data)
    .filter(([k]) => k !== 'savedAt')
    .map(([k, v]) => {
      const q = QA_QUESTIONS.find(q => q.field === k);
      const label = q ? q.q : k;
      const val = Array.isArray(v) ? v.join('、') : v;
      return `• ${label}  →  ${val}`;
    });
  text.textContent = lines.join('\n');
}

/* ==================================================
   图片上传 + 识别
   ================================================== */
let currentImage = null;     // { dataUrl, recognizeText }
let currentCandidates = [];   // 当前候选文案

function setupUpload() {
  const area = $('#uploadArea');
  const fileInput = $('#fileInput');

  area.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG') return;
    fileInput.click();
  });

  ['dragenter', 'dragover'].forEach(ev =>
    area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('drag'); })
  );

  area.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  });

  $('#btnClearImg').addEventListener('click', () => {
    currentImage = null;
    $('#previewImg').src = '';
    $('#uploadArea').classList.remove('has-img');
    $('#btnRecognize').disabled = true;
    $('#recognizeBox').hidden = true;
    $('#recognizeText').textContent = '';
    fileInput.value = '';
    toast('已清空');
  });

  $('#btnRecognize').addEventListener('click', doRecognize);
}

async function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    toast('⚠️ 请上传图片文件');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast('⚠️ 图片过大（建议 < 5MB）');
    return;
  }
  const dataUrl = await fileToBase64(file);
  $('#previewImg').src = dataUrl;
  $('#uploadArea').classList.add('has-img');
  currentImage = { dataUrl, recognizeText: '' };
  $('#btnRecognize').disabled = false;
  $('#recognizeBox').hidden = true;
  $('#recognizeText').textContent = '';
}

async function doRecognize() {
  if (!currentImage?.dataUrl) { toast('⚠️ 请先上传图片'); return; }
  if (!cfg.apiKey) { toast('⚠️ 请先在「配置」中填入 API Key'); switchTab('settings'); return; }
  showLoading('正在识别图片内容...');
  try {
    const text = await recognizeImage(currentImage.dataUrl);
    currentImage.recognizeText = text;
    hideLoading();
    $('#recognizeBox').hidden = false;
    $('#recognizeText').textContent = text;
    toast('✅ 识别完成');
  } catch (e) {
    hideLoading();
    console.error(e);
    $('#recognizeBox').hidden = false;
    $('#recognizeText').textContent = '❌ 识别失败：' + (e.message || e);
  }
}

/* ==================================================
   文案生成
   ================================================== */
function buildProfileContext() {
  if (!profile || Object.keys(profile).length === 0) return '';
  const lines = Object.entries(profile)
    .filter(([k]) => k !== 'savedAt')
    .map(([k, v]) => {
      const q = QA_QUESTIONS.find(q => q.field === k);
      const label = q ? q.q : k;
      const val = Array.isArray(v) ? v.join('、') : v;
      return `- ${label}: ${val}`;
    });
  return lines.join('\n');
}

function buildSystemPrompt() {
  const base = `你是一位资深的社交媒体文案编辑，擅长为用户的朋友圈撰写高质量、自然不生硬的中文文案。请根据用户提供的图片识别结果和用户画像，输出 3 条不同风格的候选文案。

【输出要求】
- 每条文案长度建议 40-140 字（中文），风格自然、口语化，符合朋友圈阅读习惯
- 可适当使用 emoji 与 hashtag #xxx，具体频率由用户画像决定
- 不同候选之间在句式、语气、情绪上要有明显区分
- 不要输出"朋友圈文案1"等多余说明，直接给出内容本身

【输出格式】请严格使用如下 JSON 格式输出：
{
  "candidates": [
    { "style": "风格标签（如：文艺走心 / 活泼搞笑 / 简洁直接）", "text": "文案内容" },
    { "style": "风格标签", "text": "文案内容" },
    { "style": "风格标签", "text": "文案内容" }
  ]
}`;
  return base;
}

async function doGenerate() {
  if (!cfg.apiKey) { toast('⚠️ 请先在「配置」中填入 API Key'); switchTab('settings'); return; }
  const style = $('#styleInput').value.trim();
  const extra = $('#extraInput').value.trim();
  const hasImage = currentImage?.recognizeText;

  if (!hasImage && !extra && !style) {
    toast('⚠️ 请至少上传图片并识别，或补充一些描述');
    return;
  }

  showLoading('正在生成朋友圈文案...');
  $('#genStatus').textContent = '';

  const userParts = [];
  if (hasImage) userParts.push(`【图片识别结果】\n${currentImage.recognizeText}`);
  if (style)    userParts.push(`【用户指定风格偏好】：${style}`);
  if (extra)    userParts.push(`【用户额外补充】：${extra}`);

  const profileCtx = buildProfileContext();
  if (profileCtx) userParts.push(`【用户画像】\n${profileCtx}`);

  userParts.push('请基于以上信息，输出 3 条不同风格的朋友圈候选文案，严格按 JSON 格式返回。');

  try {
    const data = await callChat([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userParts.join('\n\n') },
    ], cfg.textModel, 1200, 0.8);

    const raw = extractText(data);
    const candidates = parseCandidates(raw);
    hideLoading();

    if (!candidates.length) {
      $('#genBox').hidden = false;
      $('#candidatesList').innerHTML = `<div class="candidate-card"><div class="candidate-content">${raw || 'AI 返回内容为空'}</div></div>`;
      return;
    }

    currentCandidates = candidates;
    renderCandidates();
    toast('✅ 文案生成完成');
  } catch (e) {
    hideLoading();
    console.error(e);
    $('#genStatus').textContent = '❌ ' + (e.message || '生成失败');
    toast('生成失败：' + (e.message || ''));
  }
}

function parseCandidates(raw) {
  if (!raw) return [];
  // 尝试提取 JSON
  let jsonStr = raw;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) jsonStr = m[0];
  try {
    const obj = JSON.parse(jsonStr);
    if (Array.isArray(obj.candidates) && obj.candidates.length) {
      return obj.candidates.map(c => ({
        style: String(c.style || '').slice(0, 20) || '风格',
        text: String(c.text || '').trim(),
      })).filter(c => c.text);
    }
  } catch (e) { /* fallthrough */ }

  // 若 JSON 失败，尝试按编号/分段解析
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^[\d①②③④⑤⑥●•\-\*]+[\.\s、]+(.+)$/);
    if (head || /^(文案|风格|候选)/.test(line)) {
      if (cur) chunks.push(cur);
      cur = { style: (head ? head[1] : line).slice(0, 20), text: '' };
    } else if (cur) {
      cur.text = cur.text ? cur.text + '\n' + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter(c => c.text);
}

function renderCandidates() {
  const list = $('#candidatesList');
  list.innerHTML = '';
  currentCandidates.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'candidate-card';
    card.innerHTML = `
      <div class="candidate-tag">✦ ${c.style}</div>
      <div class="candidate-content"></div>
      <div class="candidate-actions">
        <button class="mini-btn primary" data-act="copy">📋 复制</button>
        <button class="mini-btn" data-act="add">➕ 加入今日规划</button>
        <button class="mini-btn" data-act="regen">🔁 仅重新生成此条</button>
      </div>
    `;
    card.querySelector('.candidate-content').textContent = c.text;
    card.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'copy') {
          const ok = await copyText(c.text);
          toast(ok ? '✅ 已复制' : '复制失败');
        } else if (act === 'add') {
          addToPlan({
            text: c.text,
            style: c.style,
            image: currentImage?.dataUrl || null,
            recognizeText: currentImage?.recognizeText || '',
            createdAt: Date.now(),
          });
        } else if (act === 'regen') {
          regenerateOne(i);
        }
      });
    });
    list.appendChild(card);
  });
  $('#genBox').hidden = false;
}

async function regenerateOne(idx) {
  if (!cfg.apiKey) { toast('⚠️ 请先配置 API Key'); return; }
  showLoading('重新生成中...');
  try {
    const style = $('#styleInput').value.trim();
    const extra = $('#extraInput').value.trim();
    const parts = [];
    if (currentImage?.recognizeText) parts.push(`【图片识别结果】\n${currentImage.recognizeText}`);
    if (style) parts.push(`【风格偏好】${style}`);
    if (extra) parts.push(`【补充】${extra}`);
    const ctx = buildProfileContext();
    if (ctx) parts.push(`【用户画像】\n${ctx}`);
    parts.push(`请基于以上信息，输出 1 条与已有风格不同的朋友圈文案，JSON 格式：{"style":"标签","text":"内容"}`);

    const data = await callChat([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: parts.join('\n\n') },
    ], cfg.textModel, 500, 0.9);

    const raw = extractText(data);
    const list = parseCandidates(raw);
    hideLoading();
    if (list.length) {
      currentCandidates[idx] = list[0];
      renderCandidates();
      toast('✅ 已刷新');
    } else {
      toast('解析失败，请重试');
    }
  } catch (e) {
    hideLoading();
    toast('生成失败：' + (e.message || ''));
  }
}

/* ==================================================
   今日规划
   ================================================== */
function getPlan() {
  return safeGet(LS.PLAN_PREFIX + todayKey(), []);
}
function setPlan(list) {
  safeSet(LS.PLAN_PREFIX + todayKey(), list);
}

function addToPlan(item) {
  const plan = getPlan();
  plan.unshift(item);
  setPlan(plan);
  toast('✅ 已加入今日规划');
  renderPlan();
}

function removeFromPlan(idx) {
  const plan = getPlan();
  plan.splice(idx, 1);
  setPlan(plan);
  renderPlan();
  toast('已移除');
}

function clearPlan() {
  if (!confirm('确定清空今日所有规划？此操作不可撤销。')) return;
  setPlan([]);
  renderPlan();
  toast('已清空');
}

function renderPlan() {
  const list = getPlan();
  const wrap = $('#planList');
  const empty = $('#planEmpty');
  wrap.innerHTML = '';

  const d = new Date();
  $('#planDate').textContent = `${todayKey()} · 共 ${list.length} 条朋友圈待发布`;

  if (!list.length) {
    empty.classList.add('show');
    return;
  }
  empty.classList.remove('show');

  list.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'plan-item';
    const timeStr = new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false });
    el.innerHTML = `
      <div class="plan-item-head">
        <span>📌 ${item.style || '文案'} · ${timeStr}</span>
        <span>#${list.length - idx}</span>
      </div>
      ${item.image ? `<img class="plan-thumb" src="${item.image}" alt="配图" />` : ''}
      <div class="plan-content"></div>
      <div class="plan-actions-row">
        <button class="mini-btn primary" data-act="copy">📋 复制文案</button>
        <button class="mini-btn" data-act="copy-with-img">🖼️ 复制文案（仅文字 + 提示配图）</button>
        <button class="mini-btn" data-act="remove">🗑️ 从此规划移除</button>
      </div>
    `;
    el.querySelector('.plan-content').textContent = item.text;
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'copy') {
          const ok = await copyText(item.text);
          toast(ok ? '✅ 文案已复制，快去粘贴到朋友圈吧～' : '复制失败');
        } else if (act === 'copy-with-img') {
          const tip = item.image ? '\n\n[ 提示：记得同时上传对应的图片到朋友圈 ]' : '';
          await copyText(item.text + tip);
          toast('✅ 已复制');
        } else if (act === 'remove') {
          removeFromPlan(idx);
        }
      });
    });
    wrap.appendChild(el);
  });
}

/* ==================================================
   Tab 切换
   ================================================== */
function switchTab(name) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.btb-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'plan') renderPlan();
  if (name === 'profile') {
    if (qaStep === -1 && !profile) {
      // 自动开始第一题
      startQA();
    } else {
      // 展示画像 + 可继续
      refreshProfilePreview();
      if ($('#qaFlow').children.length === 0) {
        // 没有正在进行的问答流 → 以总结形式展示
        const flow = $('#qaFlow');
        flow.innerHTML = '';
        const sum = document.createElement('div');
        sum.className = 'qa-summary';
        const lines = Object.entries(profile || {}).filter(([k]) => k !== 'savedAt').map(([k, v]) => {
          const q = QA_QUESTIONS.find(qq => qq.field === k);
          const label = q ? q.q : k;
          const val = Array.isArray(v) ? v.join('、') : v;
          return `<div style="margin:4px 0"><strong>• ${label}</strong>：${val}</div>`;
        }).join('');
        sum.innerHTML = `
          <div class="qa-summary-title">📊 我的画像</div>
          ${lines || '<div style="color:var(--c-text-mute)">暂无画像，可点击下方开始问答。</div>'}
          <div class="action-row">
            <button class="btn btn-ghost" id="qaContinue">🔄 重新问答</button>
          </div>
        `;
        flow.appendChild(sum);
        sum.querySelector('#qaContinue').addEventListener('click', startQA);
      }
    }
  }
}

/* ==================================================
   初始化
   ================================================== */
function init() {
  // tab nav (顶部 + 底部)
  $$('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  $$('.btb-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // 配置
  loadCfgToUI();
  $('#btnSaveCfg').addEventListener('click', saveCfgFromUI);
  $('#btnTestCfg').addEventListener('click', testCfg);

  // 图片上传
  setupUpload();

  // 生成文案
  $('#btnGenerate').addEventListener('click', doGenerate);

  // 用户画像
  $('#btnProfileReset').addEventListener('click', startQA);
  $('#btnProfileEdit').addEventListener('click', () => {
    toast('💡 可在问答流中点击选项重新选择，或点击"重新开始问答"');
  });

  // 规划
  $('#btnClearPlan').addEventListener('click', clearPlan);
  renderPlan();

  // 默认状态
  if (profile && Object.keys(profile).length) {
    // 用户已有画像，面板内展示而不强制重走流程
  } else {
    // 无画像，在切到 profile 时会自动触发
  }

  // 若未配置，提醒
  if (!cfg.apiKey) {
    setTimeout(() => toast('⚠️ 首次使用请先在「⚙️ 配置」中填入 API Key'), 500);
  }

  // 注册 Service Worker（PWA 离线支持）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').then(() => {
      console.log('Service Worker registered');
    }).catch(err => {
      console.warn('Service Worker registration failed:', err);
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
