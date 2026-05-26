// Pétanque Helper – client-side logic

const MARKER_R = 15;      // visual radius (CSS px)
const SNAP_R   = 28;      // snap-to-suggestion radius (CSS px)

// ── State ─────────────────────────────────────────────────────────────

const state = {
  mode: 'camera',            // 'camera' | 'analysis'
  tool: 'cochonnet',         // active marking tool
  cochonnet: null,           // {x, y} in image px
  teamA: [],                 // [{x, y}] in image px
  teamB: [],                 // [{x, y}] in image px
  suggestions: [],           // [{x, y, r}] from auto-detect, not yet assigned
  capturedImage: null,       // HTMLImageElement
  imgW: 0,
  imgH: 0,
  // canvas → image transform
  scale: 1,
  offX: 0,
  offY: 0,
  stream: null,
  detecting: false,
};

// ── DOM ───────────────────────────────────────────────────────────────

const video       = document.getElementById('video');
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d');
const cameraModeEl   = document.getElementById('camera-mode');
const analysisModeEl = document.getElementById('analysis-mode');
const resultsEl   = document.getElementById('results-panel');

// ── Init ──────────────────────────────────────────────────────────────

async function init() {
  await startCamera();

  document.getElementById('capture-btn').addEventListener('click', capturePhoto);
  document.getElementById('detect-btn').addEventListener('click', autoDetect);
  document.getElementById('reset-btn').addEventListener('click', () => resetMarkers(true));
  document.getElementById('new-btn').addEventListener('click', () => switchMode('camera'));

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  canvas.addEventListener('touchstart', onTouch, { passive: false });
  canvas.addEventListener('click', onClick);

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120));
}

// ── Camera ────────────────────────────────────────────────────────────

async function startCamera() {
  const container = document.querySelector('.camera-container');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
  } catch (err) {
    container.innerHTML = `
      <div class="cam-error">
        <div style="font-size:48px">📷</div>
        <div>Camera access denied.</div>
        <div>Allow camera permission in your browser settings and reload.</div>
      </div>`;
  }
}

function capturePhoto() {
  const w = video.videoWidth  || 1280;
  const h = video.videoHeight || 720;

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').drawImage(video, 0, 0);

  const img = new Image();
  img.onload = () => {
    state.capturedImage = img;
    state.imgW = w;
    state.imgH = h;
    state.suggestions = [];
    resetMarkers(false);
    switchMode('analysis');
    updateCanvasLayout();
    redraw();
  };
  img.src = tmp.toDataURL('image/jpeg', 0.92);
}

// ── Canvas layout ─────────────────────────────────────────────────────

function updateCanvasLayout() {
  const container = canvas.parentElement;
  const cW = container.clientWidth;
  const cH = container.clientHeight;
  const dpr = window.devicePixelRatio || 1;

  const s = Math.min(cW / state.imgW, cH / state.imgH);
  state.scale = s;
  state.offX  = (cW - state.imgW * s) / 2;
  state.offY  = (cH - state.imgH * s) / 2;

  // Setting canvas.width resets the context transform — apply DPR scale once after
  canvas.width  = cW * dpr;
  canvas.height = cH * dpr;
  canvas.style.width  = cW + 'px';
  canvas.style.height = cH + 'px';
  ctx.scale(dpr, dpr);
}

function onResize() {
  if (state.mode === 'analysis' && state.capturedImage) {
    updateCanvasLayout();
    redraw();
  }
}

// ── Interaction ───────────────────────────────────────────────────────

let lastTouchTime = 0;

function onTouch(e) {
  e.preventDefault();
  if (e.touches.length !== 1) return;
  lastTouchTime = Date.now();
  const t   = e.touches[0];
  const r   = canvas.getBoundingClientRect();
  interact(t.clientX - r.left, t.clientY - r.top);
}

function onClick(e) {
  // Prevent double-firing after touch events
  if (Date.now() - lastTouchTime < 500) return;
  const r = canvas.getBoundingClientRect();
  interact(e.clientX - r.left, e.clientY - r.top);
}

function interact(cx, cy) {
  // Convert CSS-px canvas coords → image coords
  const ix = (cx - state.offX) / state.scale;
  const iy = (cy - state.offY) / state.scale;

  // Ignore taps outside the image area
  if (ix < 0 || ix > state.imgW || iy < 0 || iy > state.imgH) return;

  const pt = { x: ix, y: iy };

  if (state.tool === 'erase') {
    erase(pt);
  } else {
    // Snap to nearest suggestion within range
    const snapR = SNAP_R / state.scale;
    const si    = state.suggestions.findIndex(s => dist(s, pt) < snapR);
    const pos   = si >= 0
      ? { x: state.suggestions[si].x, y: state.suggestions[si].y }
      : pt;
    if (si >= 0) state.suggestions.splice(si, 1);

    if      (state.tool === 'cochonnet') state.cochonnet = pos;
    else if (state.tool === 'team-a')    state.teamA.push(pos);
    else if (state.tool === 'team-b')    state.teamB.push(pos);
  }

  redraw();
  updateResults();
}

function erase(pt) {
  const r = SNAP_R / state.scale;

  if (state.cochonnet && dist(state.cochonnet, pt) < r) {
    state.cochonnet = null;
    return;
  }

  let i = state.teamA.findIndex(p => dist(p, pt) < r);
  if (i >= 0) { state.teamA.splice(i, 1); return; }

  i = state.teamB.findIndex(p => dist(p, pt) < r);
  if (i >= 0) { state.teamB.splice(i, 1); return; }

  i = state.suggestions.findIndex(p => dist(p, pt) < r);
  if (i >= 0) state.suggestions.splice(i, 1);
}

// ── Drawing ───────────────────────────────────────────────────────────

function redraw() {
  if (!state.capturedImage) return;

  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);

  // Background image
  ctx.drawImage(
    state.capturedImage,
    state.offX, state.offY,
    state.imgW * state.scale,
    state.imgH * state.scale,
  );

  // Distance lines (drawn behind markers)
  if (state.cochonnet) {
    const c = toC(state.cochonnet);
    for (const b of state.teamA) drawLine(c, toC(b), '#4a9eda');
    for (const b of state.teamB) drawLine(c, toC(b), '#e74c3c');
  }

  // Distance labels
  if (state.cochonnet) {
    for (const b of state.teamA) drawDistLabel(toC(state.cochonnet), toC(b), dist(state.cochonnet, b), '#4a9eda');
    for (const b of state.teamB) drawDistLabel(toC(state.cochonnet), toC(b), dist(state.cochonnet, b), '#e74c3c');
  }

  // Suggestion dots (gray dashed circles from auto-detect)
  for (const s of state.suggestions) drawSuggestion(toC(s));

  // Team markers
  for (let i = 0; i < state.teamA.length; i++) drawMarker(toC(state.teamA[i]), '#4a9eda', `A${i + 1}`);
  for (let i = 0; i < state.teamB.length; i++) drawMarker(toC(state.teamB[i]), '#e74c3c', `B${i + 1}`);

  // Jack on top
  if (state.cochonnet) drawJack(toC(state.cochonnet));
}

function toC(p) {
  return { x: p.x * state.scale + state.offX, y: p.y * state.scale + state.offY };
}

function drawLine(a, b, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function drawDistLabel(from, to, d, color) {
  const mx   = (from.x + to.x) / 2;
  const my   = (from.y + to.y) / 2;
  const text = Math.round(d) + '';

  ctx.save();
  ctx.font         = 'bold 11px -apple-system, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const tw  = ctx.measureText(text).width;
  const pad = 5;

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  roundRect(ctx, mx - tw / 2 - pad, my - 9, tw + pad * 2, 18, 4);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.fillText(text, mx, my + 0.5);
  ctx.restore();
}

function drawMarker(pos, color, label) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur  = 6;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, MARKER_R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth   = 2;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  ctx.font         = 'bold 10px -apple-system, sans-serif';
  ctx.fillStyle    = '#fff';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, pos.x, pos.y + 0.5);
  ctx.restore();
}

function drawJack(pos) {
  const r = MARKER_R;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur  = 6;
  // Outer ring
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r + 4, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth   = 2;
  ctx.stroke();
  // Fill
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fillStyle   = '#f5a623';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 2;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  ctx.font         = 'bold 11px -apple-system, sans-serif';
  ctx.fillStyle    = '#fff';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('J', pos.x, pos.y + 0.5);
  ctx.restore();
}

function drawSuggestion(pos) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, MARKER_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── Results ───────────────────────────────────────────────────────────

function updateResults() {
  if (!state.cochonnet || !state.teamA.length || !state.teamB.length) {
    resultsEl.classList.add('hidden');
    return;
  }

  const dA = state.teamA.map(b => dist(state.cochonnet, b)).sort((a, b) => a - b);
  const dB = state.teamB.map(b => dist(state.cochonnet, b)).sort((a, b) => a - b);
  const mA = dA[0];
  const mB = dB[0];

  let html;
  if (Math.abs(mA - mB) < 4) {
    html = `<div class="result-tie">⚖️ Too close to call — reposition camera</div>`;
  } else if (mA < mB) {
    const pts = dA.filter(d => d < mB).length;
    html = `<div class="result-winner" style="color:#4a9eda">
              Team A scores ${pts} point${pts > 1 ? 's' : ''}!
            </div>
            <div class="result-detail">Closest A: ${Math.round(mA)} · Closest B: ${Math.round(mB)}</div>`;
  } else {
    const pts = dB.filter(d => d < mA).length;
    html = `<div class="result-winner" style="color:#e74c3c">
              Team B scores ${pts} point${pts > 1 ? 's' : ''}!
            </div>
            <div class="result-detail">Closest B: ${Math.round(mB)} · Closest A: ${Math.round(mA)}</div>`;
  }

  resultsEl.innerHTML = html;
  resultsEl.classList.remove('hidden');
}

// ── Auto-detect ───────────────────────────────────────────────────────

async function autoDetect() {
  if (state.detecting || !state.capturedImage) return;
  state.detecting = true;

  const btn = document.getElementById('detect-btn');
  btn.textContent = '⏳';
  btn.disabled = true;

  try {
    // Downscale before sending to reduce payload
    const maxDim = 1024;
    const s      = Math.min(maxDim / state.imgW, maxDim / state.imgH, 1);
    const tmp    = document.createElement('canvas');
    tmp.width    = Math.round(state.imgW * s);
    tmp.height   = Math.round(state.imgH * s);
    tmp.getContext('2d').drawImage(state.capturedImage, 0, 0, tmp.width, tmp.height);

    const resp = await fetch('/api/detect', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ image: tmp.toDataURL('image/jpeg', 0.85) }),
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    // Scale detected circle centres back to full-image coordinates
    const scaleBack    = state.imgW / tmp.width;
    state.suggestions  = data.circles.map(c => ({
      x: c.x * scaleBack,
      y: c.y * scaleBack,
      r: c.r * scaleBack,
    }));

    redraw();

    if (state.suggestions.length === 0) {
      showToast('No balls detected. Tap to place markers manually.');
    } else {
      showToast(`${state.suggestions.length} ball(s) detected — tap each to assign it.`);
    }
  } catch {
    showToast('Detection failed. Place markers manually.', true);
  } finally {
    state.detecting  = false;
    btn.textContent  = '🔍 Auto';
    btn.disabled     = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function resetMarkers(doRedraw) {
  state.cochonnet = null;
  state.teamA     = [];
  state.teamB     = [];
  if (doRedraw) { redraw(); updateResults(); }
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

function switchMode(mode) {
  state.mode = mode;
  cameraModeEl.classList.toggle('hidden',   mode !== 'camera');
  analysisModeEl.classList.toggle('hidden', mode !== 'analysis');
}

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' toast-error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

// ── Boot ──────────────────────────────────────────────────────────────

init();
