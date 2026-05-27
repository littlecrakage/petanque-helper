// Pétanque Helper – client-side logic

const MARKER_R = 15;      // visual radius (CSS px)
const SNAP_R   = 28;      // snap-to-suggestion radius (CSS px)

// ── State ─────────────────────────────────────────────────────────────

const state = {
  mode: 'camera',
  tool: 'cochonnet',
  cochonnet: null,
  teamA: [],
  teamB: [],
  suggestions: [],
  capturedImage: null,
  imgW: 0,
  imgH: 0,
  scale: 1,
  offX: 0,
  offY: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  jackR: 25,    // jack circle radius in image pixels
  ballR: 40,    // default ball radius in image pixels
  stream: null,
  detecting: false,
};

// ── DOM ───────────────────────────────────────────────────────────────

const video          = document.getElementById('video');
const canvas         = document.getElementById('canvas');
const ctx            = canvas.getContext('2d');
const cameraModeEl   = document.getElementById('camera-mode');
const analysisModeEl = document.getElementById('analysis-mode');
const resultsEl      = document.getElementById('results-panel');
const zoomResetBtn   = document.getElementById('zoom-reset-btn');

// ── Init ──────────────────────────────────────────────────────────────

async function init() {
  await startCamera();

  document.getElementById('capture-btn').addEventListener('click', capturePhoto);
  document.getElementById('detect-btn').addEventListener('click', autoDetect);
  document.getElementById('reset-btn').addEventListener('click', () => resetMarkers(true));
  document.getElementById('new-btn').addEventListener('click', () => switchMode('camera'));

  const fileInput = document.getElementById('file-input');
  document.getElementById('load-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadFromFile(file);
    fileInput.value = '';
  });
  zoomResetBtn.addEventListener('click', resetZoom);

  document.getElementById('jack-size').addEventListener('input', e => {
    state.jackR = +e.target.value;
    redraw();
    updateResults();
  });

  document.getElementById('ball-size').addEventListener('input', e => {
    state.ballR = +e.target.value;
    redraw();
    updateResults();
  });

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  canvas.addEventListener('touchstart',  onTouchStart, { passive: false });
  canvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
  canvas.addEventListener('touchend',    onTouchEnd,   { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd,   { passive: false });
  canvas.addEventListener('click',       onClick);
  canvas.addEventListener('wheel',       onWheel, { passive: false });
  canvas.addEventListener('mousedown',   onMouseDown);
  canvas.addEventListener('mousemove',   onMouseMove);
  canvas.addEventListener('mouseup',     onMouseUp);

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
    try { syncJackSlider(); } catch (_) {}
    redraw();
  };
  img.src = tmp.toDataURL('image/jpeg', 0.92);
}

function loadFromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.capturedImage = img;
    state.imgW = img.naturalWidth;
    state.imgH = img.naturalHeight;
    state.suggestions = [];
    resetMarkers(false);
    switchMode('analysis');
    updateCanvasLayout();
    try { syncJackSlider(); } catch (_) {}
    redraw();
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function syncJackSlider() {
  state.jackR = Math.max(3, Math.min(300, Math.round(state.imgW * 0.025)));
  const slider = document.getElementById('jack-size');
  if (slider) {
    slider.max   = Math.round(state.imgW * 0.12);
    slider.value = state.jackR;
  }

  state.ballR = Math.max(3, Math.min(300, Math.round(state.imgW * 0.08)));
  const bslider = document.getElementById('ball-size');
  if (bslider) {
    bslider.max   = Math.round(state.imgW * 0.30);
    bslider.value = state.ballR;
  }
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

  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;

  // Setting canvas.width resets the context transform — apply DPR scale once after
  canvas.width  = cW * dpr;
  canvas.height = cH * dpr;
  canvas.style.width  = cW + 'px';
  canvas.style.height = cH + 'px';
  ctx.scale(dpr, dpr);

  updateZoomIndicator();
}

function onResize() {
  if (state.mode === 'analysis' && state.capturedImage) {
    updateCanvasLayout();
    redraw();
  }
}

// ── Coordinate helpers ────────────────────────────────────────────────

function toC(p) {
  const s = state.scale * state.zoom;
  return { x: p.x * s + state.offX + state.panX, y: p.y * s + state.offY + state.panY };
}

function screenToImg(cx, cy) {
  const s = state.scale * state.zoom;
  return {
    x: Math.max(0, Math.min(state.imgW, (cx - state.offX - state.panX) / s)),
    y: Math.max(0, Math.min(state.imgH, (cy - state.offY - state.panY) / s)),
  };
}

function clampPan() {
  if (state.zoom <= 1.0) {
    state.panX = 0;
    state.panY = 0;
    return;
  }
  const s  = state.scale * state.zoom;
  const iw = state.imgW * s;
  const ih = state.imgH * s;
  const W  = canvas.clientWidth;
  const H  = canvas.clientHeight;
  const mg = 40;
  state.panX = Math.max(mg - state.offX - iw, Math.min(W - mg - state.offX, state.panX));
  state.panY = Math.max(mg - state.offY - ih, Math.min(H - mg - state.offY, state.panY));
}

function resetZoom() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateZoomIndicator();
  redraw();
}

function updateZoomIndicator() {
  const zoomed = state.zoom > 1.05;
  zoomResetBtn.textContent = state.zoom.toFixed(1) + '×  ✕';
  zoomResetBtn.classList.toggle('hidden', !zoomed);
}

// ── Touch gestures ────────────────────────────────────────────────────

let lastTouchTime    = 0;
let touch1           = null;
let touch2           = null;
let touchStartX      = 0;
let touchStartY      = 0;
let touchHasMoved    = false;
let isPanning        = false;
let initialPinchDist = 0;
let initialZoom      = 1;
let initialPanX      = 0;
let initialPanY      = 0;
let dragTarget       = null;

function findMarkerAt(cx, cy) {
  const hit = MARKER_R * 2.2;
  if (state.cochonnet) {
    const p = toC(state.cochonnet);
    const jackHit = Math.max(hit, state.jackR * state.scale * state.zoom);
    if (Math.hypot(cx - p.x, cy - p.y) < jackHit) return { type: 'cochonnet', index: 0 };
  }
  for (let i = 0; i < state.teamA.length; i++) {
    const p = toC(state.teamA[i]);
    if (Math.hypot(cx - p.x, cy - p.y) < hit) return { type: 'team-a', index: i };
  }
  for (let i = 0; i < state.teamB.length; i++) {
    const p = toC(state.teamB[i]);
    if (Math.hypot(cx - p.x, cy - p.y) < hit) return { type: 'team-b', index: i };
  }
  return null;
}

function moveMarker(target, cx, cy) {
  const { x, y } = screenToImg(cx, cy);
  if (target.type === 'cochonnet' && state.cochonnet) {
    state.cochonnet.x = x; state.cochonnet.y = y;
  } else if (target.type === 'team-a' && state.teamA[target.index]) {
    state.teamA[target.index].x = x; state.teamA[target.index].y = y;
  } else if (target.type === 'team-b' && state.teamB[target.index]) {
    state.teamB[target.index].x = x; state.teamB[target.index].y = y;
  }
}

function onTouchStart(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();

  if (e.touches.length === 1) {
    const t  = e.touches[0];
    const cx = t.clientX - r.left;
    const cy = t.clientY - r.top;
    touch1        = { id: t.identifier, x: cx, y: cy };
    touch2        = null;
    touchStartX   = cx;
    touchStartY   = cy;
    touchHasMoved = false;
    isPanning     = false;
    dragTarget    = findMarkerAt(cx, cy);
  } else if (e.touches.length === 2) {
    dragTarget  = null;
    isPanning   = true;
    const t1    = e.touches[0];
    const t2    = e.touches[1];
    touch1 = { id: t1.identifier, x: t1.clientX - r.left, y: t1.clientY - r.top };
    touch2 = { id: t2.identifier, x: t2.clientX - r.left, y: t2.clientY - r.top };
    initialPinchDist = Math.hypot(touch2.x - touch1.x, touch2.y - touch1.y);
    initialZoom  = state.zoom;
    initialPanX  = state.panX;
    initialPanY  = state.panY;
  }
}

function onTouchMove(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();

  if (e.touches.length === 1 && touch1) {
    const t  = e.touches[0];
    const cx = t.clientX - r.left;
    const cy = t.clientY - r.top;

    if (dragTarget) {
      touchHasMoved = true;
      moveMarker(dragTarget, cx, cy);
      redraw();
      updateResults();
    } else {
      const dx = cx - touchStartX;
      const dy = cy - touchStartY;
      if (isPanning || Math.hypot(dx, dy) > 8) {
        if (!isPanning) {
          isPanning   = true;
          initialPanX = state.panX;
          initialPanY = state.panY;
        }
        touchHasMoved = true;
        state.panX    = initialPanX + (cx - touchStartX);
        state.panY    = initialPanY + (cy - touchStartY);
        clampPan();
        updateZoomIndicator();
        redraw();
      }
    }
  } else if (e.touches.length === 2 && touch1 && touch2) {
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const c1 = { x: t1.clientX - r.left, y: t1.clientY - r.top };
    const c2 = { x: t2.clientX - r.left, y: t2.clientY - r.top };
    touchHasMoved = true;

    const newDist = Math.hypot(c2.x - c1.x, c2.y - c1.y);
    const newZoom = Math.max(0.8, Math.min(8, initialZoom * (newDist / initialPinchDist)));

    // Keep the initial pinch midpoint fixed in image space
    const midX0 = (touch1.x + touch2.x) / 2;
    const midY0 = (touch1.y + touch2.y) / 2;
    const midX1 = (c1.x + c2.x) / 2;
    const midY1 = (c1.y + c2.y) / 2;
    const s  = state.scale;
    const ix = (midX0 - state.offX - initialPanX) / (s * initialZoom);
    const iy = (midY0 - state.offY - initialPanY) / (s * initialZoom);

    state.zoom = newZoom;
    state.panX = midX1 - state.offX - ix * s * newZoom;
    state.panY = midY1 - state.offY - iy * s * newZoom;

    clampPan();
    updateZoomIndicator();
    redraw();
  }
}

function onTouchEnd(e) {
  e.preventDefault();

  if (dragTarget && touchHasMoved) {
    // Finished dragging a marker
    dragTarget    = null;
    lastTouchTime = Date.now();
  } else if (!touchHasMoved && e.changedTouches.length === 1) {
    // Short tap — place or erase (but not on an existing marker in placement mode)
    lastTouchTime = Date.now();
    const r  = canvas.getBoundingClientRect();
    const t  = e.changedTouches[0];
    const cx = t.clientX - r.left;
    const cy = t.clientY - r.top;
    if (state.tool === 'erase' || !dragTarget) {
      interact(cx, cy);
    }
  }

  dragTarget = null;

  if (e.touches.length === 0) {
    touch1    = null;
    touch2    = null;
    isPanning = false;
  } else if (e.touches.length === 1) {
    // One finger lifted during pinch — reset for remaining finger
    touch2        = null;
    isPanning     = false;
    const t       = e.touches[0];
    const r       = canvas.getBoundingClientRect();
    touch1        = { id: t.identifier, x: t.clientX - r.left, y: t.clientY - r.top };
    touchStartX   = touch1.x;
    touchStartY   = touch1.y;
    touchHasMoved = false;
    initialPanX   = state.panX;
    initialPanY   = state.panY;
  }
}

// ── Mouse (desktop) ───────────────────────────────────────────────────

let mouseDown      = false;
let mouseMoved     = false;
let mouseStartX    = 0;
let mouseStartY    = 0;
let mousePanStartX = 0;
let mousePanStartY = 0;
let mouseTarget    = null;

function onMouseDown(e) {
  if (Date.now() - lastTouchTime < 500) return;
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  mouseDown      = true;
  mouseMoved     = false;
  mouseStartX    = cx;
  mouseStartY    = cy;
  mousePanStartX = state.panX;
  mousePanStartY = state.panY;
  mouseTarget    = findMarkerAt(cx, cy);
  if (mouseTarget) canvas.style.cursor = 'grabbing';
}

function onMouseMove(e) {
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;

  if (!mouseDown) {
    canvas.style.cursor = findMarkerAt(cx, cy) ? 'grab' : 'crosshair';
    return;
  }

  if (Math.hypot(cx - mouseStartX, cy - mouseStartY) < 4) return;
  mouseMoved = true;

  if (mouseTarget) {
    moveMarker(mouseTarget, cx, cy);
    redraw();
    updateResults();
  } else {
    state.panX = mousePanStartX + (cx - mouseStartX);
    state.panY = mousePanStartY + (cy - mouseStartY);
    clampPan();
    updateZoomIndicator();
    redraw();
  }
}

function onMouseUp() {
  mouseDown   = false;
  mouseTarget = null;
  canvas.style.cursor = 'crosshair';
}

function onWheel(e) {
  e.preventDefault();
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;

  const factor  = e.deltaY > 0 ? 0.85 : 1.18;
  const newZoom = Math.max(0.8, Math.min(8, state.zoom * factor));

  // Keep the point under the cursor fixed in image space
  const s  = state.scale;
  const ix = (cx - state.offX - state.panX) / (s * state.zoom);
  const iy = (cy - state.offY - state.panY) / (s * state.zoom);

  state.zoom = newZoom;
  state.panX = cx - state.offX - ix * s * newZoom;
  state.panY = cy - state.offY - iy * s * newZoom;

  clampPan();
  updateZoomIndicator();
  redraw();
}

// ── Interaction (place / erase markers) ──────────────────────────────

function onClick(e) {
  if (Date.now() - lastTouchTime < 500) return;
  if (mouseMoved) { mouseMoved = false; return; }
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  // Don't place a new marker on top of an existing one
  if (state.tool !== 'erase' && findMarkerAt(cx, cy)) return;
  interact(cx, cy);
}

function interact(cx, cy) {
  const s  = state.scale * state.zoom;
  const ix = (cx - state.offX - state.panX) / s;
  const iy = (cy - state.offY - state.panY) / s;

  if (ix < 0 || ix > state.imgW || iy < 0 || iy > state.imgH) return;

  const pt = { x: ix, y: iy };

  if (state.tool === 'erase') {
    erase(pt);
  } else {
    const snapR = SNAP_R / s;
    const si    = state.suggestions.findIndex(sg => dist(sg, pt) < snapR);
    const pos   = si >= 0
      ? { x: state.suggestions[si].x, y: state.suggestions[si].y, r: state.suggestions[si].r }
      : { x: pt.x, y: pt.y, r: state.ballR };
    if (si >= 0) state.suggestions.splice(si, 1);

    if      (state.tool === 'cochonnet') state.cochonnet = pos;
    else if (state.tool === 'team-a')    state.teamA.push(pos);
    else if (state.tool === 'team-b')    state.teamB.push(pos);
  }

  redraw();
  updateResults();
}

function erase(pt) {
  const r = SNAP_R / (state.scale * state.zoom);

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

  const s = state.scale * state.zoom;
  ctx.drawImage(
    state.capturedImage,
    state.offX + state.panX,
    state.offY + state.panY,
    state.imgW * s,
    state.imgH * s,
  );

  // Distance lines (behind markers) — drawn edge-to-edge
  if (state.cochonnet) {
    const c = toC(state.cochonnet);
    for (const b of state.teamA) drawLine(c, toC(b), b.r !== undefined ? b.r : state.ballR, '#4a9eda');
    for (const b of state.teamB) drawLine(c, toC(b), b.r !== undefined ? b.r : state.ballR, '#e74c3c');
  }

  // Distance labels
  if (state.cochonnet) {
    for (const b of state.teamA) drawDistLabel(toC(state.cochonnet), toC(b), edgeDist(b), '#4a9eda');
    for (const b of state.teamB) drawDistLabel(toC(state.cochonnet), toC(b), edgeDist(b), '#e74c3c');
  }

  // Suggestion dots
  for (const sg of state.suggestions) drawSuggestion(toC(sg));

  // Active drag (for highlight)
  const activeDrag = dragTarget || mouseTarget;

  const jC = state.cochonnet ? toC(state.cochonnet) : null;

  for (let i = 0; i < state.teamA.length; i++) {
    const hi = activeDrag && activeDrag.type === 'team-a' && activeDrag.index === i;
    const bC = toC(state.teamA[i]);
    jC ? drawBallMarker(bC, jC, '#4a9eda', `A${i + 1}`, hi)
       : drawMarker(bC, '#4a9eda', `A${i + 1}`, hi);
  }
  for (let i = 0; i < state.teamB.length; i++) {
    const hi = activeDrag && activeDrag.type === 'team-b' && activeDrag.index === i;
    const bC = toC(state.teamB[i]);
    jC ? drawBallMarker(bC, jC, '#e74c3c', `B${i + 1}`, hi)
       : drawMarker(bC, '#e74c3c', `B${i + 1}`, hi);
  }

  if (jC) {
    const hi = !!(activeDrag && activeDrag.type === 'cochonnet');
    drawJack(jC, hi);
  }
}

function drawLine(jackC, ballC, ballRImg, color) {
  const dx  = ballC.x - jackC.x;
  const dy  = ballC.y - jackC.y;
  const len = Math.hypot(dx, dy);
  const jrC = state.jackR * state.scale * state.zoom;
  const brC = ballRImg    * state.scale * state.zoom;
  let x1 = jackC.x, y1 = jackC.y, x2 = ballC.x, y2 = ballC.y;
  if (len > 1) {
    const ux = dx / len, uy = dy / len;
    x1 = jackC.x + ux * Math.min(jrC, len * 0.45);
    y1 = jackC.y + uy * Math.min(jrC, len * 0.45);
    x2 = ballC.x - ux * Math.min(brC, len * 0.45);
    y2 = ballC.y - uy * Math.min(brC, len * 0.45);
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
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

function drawMarker(pos, color, label, highlighted = false) {
  const r = highlighted ? MARKER_R + 5 : MARKER_R;
  ctx.save();
  ctx.shadowColor = highlighted ? color : 'rgba(0,0,0,0.55)';
  ctx.shadowBlur  = highlighted ? 14 : 6;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth   = highlighted ? 3 : 2;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  ctx.font         = 'bold 10px -apple-system, sans-serif';
  ctx.fillStyle    = '#fff';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, pos.x, pos.y + 0.5);
  ctx.restore();
}

// Resizable circle outline — drag the slider to match the real jack's size
function drawJack(pos, highlighted = false) {
  const r   = state.jackR * state.scale * state.zoom;
  const arm = 6;
  ctx.save();
  ctx.strokeStyle = '#f5a623';
  ctx.lineWidth   = highlighted ? 2.5 : 2;
  ctx.lineCap     = 'round';
  ctx.shadowColor = highlighted ? '#f5a623' : 'rgba(0,0,0,0.8)';
  ctx.shadowBlur  = highlighted ? 12 : 6;
  // Resizable circle
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, Math.max(4, r), 0, Math.PI * 2);
  ctx.stroke();
  // Small fixed-size center cross so the center is always visible
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(pos.x - arm, pos.y); ctx.lineTo(pos.x + arm, pos.y);
  ctx.moveTo(pos.x, pos.y - arm); ctx.lineTo(pos.x, pos.y + arm);
  ctx.stroke();
  ctx.restore();
}

// Perpendicular tick at ball position + arrow shaft pointing toward jack
function drawBallMarker(ballC, jackC, color, label, highlighted = false) {
  const dx  = jackC.x - ballC.x;
  const dy  = jackC.y - ballC.y;
  const len = Math.hypot(dx, dy);

  if (len < 2) {
    // Fallback: just draw a dot when ball and jack coincide
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ballC.x, ballC.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const ux = dx / len;  // unit vector toward jack
  const uy = dy / len;
  const px = -uy;       // perpendicular unit vector (CCW 90°)
  const py = ux;

  const tickLen  = highlighted ? 16 : 13;
  const shaftLen = highlighted ? 26 : 20;
  const headSize = 7;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = highlighted ? 2.5 : 2;
  ctx.lineCap     = 'round';
  ctx.shadowColor = highlighted ? color : 'rgba(0,0,0,0.7)';
  ctx.shadowBlur  = highlighted ? 12 : 5;

  // Perpendicular tick
  ctx.beginPath();
  ctx.moveTo(ballC.x - px * tickLen, ballC.y - py * tickLen);
  ctx.lineTo(ballC.x + px * tickLen, ballC.y + py * tickLen);
  ctx.stroke();

  // Arrow shaft toward jack
  const tipX = ballC.x + ux * shaftLen;
  const tipY = ballC.y + uy * shaftLen;
  ctx.beginPath();
  ctx.moveTo(ballC.x, ballC.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Filled arrowhead
  ctx.shadowBlur = 0;
  const angle = Math.atan2(uy, ux);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - Math.cos(angle - Math.PI / 6) * headSize,
    tipY - Math.sin(angle - Math.PI / 6) * headSize,
  );
  ctx.lineTo(
    tipX - Math.cos(angle + Math.PI / 6) * headSize,
    tipY - Math.sin(angle + Math.PI / 6) * headSize,
  );
  ctx.closePath();
  ctx.fill();

  // Label — placed on the side of the ball away from the jack
  const lx = ballC.x - ux * 22;
  const ly = ballC.y - uy * 22;
  ctx.font         = 'bold 11px -apple-system, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, lx - tw / 2 - 4, ly - 9, tw + 8, 18, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(label, lx, ly + 0.5);
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

  const dA = state.teamA.map(b => edgeDist(b)).sort((a, b) => a - b);
  const dB = state.teamB.map(b => edgeDist(b)).sort((a, b) => a - b);
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

    const scaleBack   = state.imgW / tmp.width;
    state.suggestions = data.circles.map(c => ({
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

function edgeDist(ball) {
  const r = ball.r !== undefined ? ball.r : state.ballR;
  return Math.max(0, dist(state.cochonnet, ball) - r - state.jackR);
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
