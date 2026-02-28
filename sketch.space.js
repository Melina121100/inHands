// sketch.space.js
// SPACE: two modes (Particles / Text) driven by hand gestures.
// open  -> joy: flat hand-shaped exclusion mask makes text reflow (no lens)
// semi  -> sad: dispersion + loss of orientation (on top of stable layout)
// closed -> fear: smaller/tighter typography + smaller exclusion mask (smooth)

// ------------------------------------------------------------
// GLOBALS
// ------------------------------------------------------------

let videoP5;
let hands;
let sending = false;

let handsData = []; // { lm: p5 coords for overlay, lmNorm: normalized 0..1 for mapping }
let showOverlay = true;

// Mode
let spaceMode = "particles"; // "particles" | "text"

// Stabilized gesture state
let lastState = "none";
let stableState = "none";
let lastSwitchMs = 0;
const HOLD_MS = 160;


// Center canvas (HTML canvas)
let stageEl, fieldCanvas, fieldCtx;
let cw = 1, ch = 1;
let dpr = 1;

// Focus and motion (center frame)
let focus = { x: 0.5, y: 0.5 }; // normalized 0..1
let focusPx = { x: 0, y: 0 };   // CSS px
let prevFocusPx = null;
let velSmooth = { x: 0, y: 0 };
let motionSmooth = 0;

// Smooth focus to reduce mask jitter
let smFocusX = 0.5;
let smFocusY = 0.5;

// Hold last good landmarks to avoid mask freeze when MediaPipe drops a frame
let lastGoodLmNorm = null;
let lastGoodLmMs = 0;
const LM_HOLD_MS = 220;

// Throttle reflow (layout) to avoid micro-freezes
let lastMaskBBox = null;
let lastLayoutMs = 0;
let lastLayoutSig = "";
let hadMaskLast = false;
const LAYOUT_MIN_MS = 45; // ~22 fps max for reflow
const MASK_MOVE_PX = 10;  // rebuild only if mask moved enough

// ------------------------------------------------------------
// PARTICLES MODE (UNCHANGED)
// ------------------------------------------------------------

let particles = [];

const FIELD = {
  countOpen: 45000,
  countSemi: 45000,
  countClosed: 45000,

  spawnPerFrame: 900,
  killPerFrame: 1200,

  bg: "#ffffff",
  ptAlphaOpen: 0.28,
  ptAlphaSemi: 0.32,
  ptAlphaClosed: 0.45,
  ptSize: 2,

  velDamp: 0.88,
  maxSpeed: 3.2,

  noiseScaleOpen: 0.0022,
  noiseScaleSemi: 0.0016,
  noiseScaleClosed: 0.0026,

  noiseForceOpen: 0.55,
  noiseForceSemi: 1.75,
  noiseForceClosed: 0.45,

  voidRadiusOpen: 0.23,
  voidRadiusSemi: 0.12,
  voidRadiusClosed: 0.07,

  repulseOpen: 2.9,
  repulseSemi: 0.9,
  attractClosed: 2.2,

  compressClosed: 0.00011,

  wrapMargin: 14
};

// ------------------------------------------------------------
// TEXT MODE
// ------------------------------------------------------------

const DEFAULT_TEXT =
  "Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt ut laoreet dolore magna aliquam erat volutpat. Ut wisi enim ad minim veniam, quis nostrud exerci tation ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat. Duis autem vel eum iriure dolor in hendrerit in vulputate velit esse molestie consequat, vel illum dolore eu feugiat nulla facilisis at vero eros et accumsan et iusto odio dignissim qui blandit praesent luptatum zzril delenit augue duis dolore te feugait nulla facilisi. Lorem ipsum dolor sit amet, cons ectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt ut laoreet dolore magna aliquam erat volutpat. Ut wisi enim ad minim veniam, quis nostrud exerci tation ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat. Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt ut laoreet dolore magna aliquam erat volutpat. Ut wisi enim ad minim veniam, quis nostrud exerci tation ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat. Duis autem vel eum iriure dolor in hendrerit in vulputate velit esse molestie consequat, vel illum dolore eu feugiat nulla facilisis at vero eros et accumsan et iusto odio dignissim qui blandit praesent luptatum zzril delenit augue duis dolore te feugait nulla facilisi.";

let textContent = DEFAULT_TEXT;

// layout chars: stable positions (x,y). For semi we add offsets and rotation.
let textChars = []; // { ch, x, y, w, line, a, ox, oy, vx, vy, rot, rv, sox, soy, srot }
let layoutDirty = true;

const TEXT_STYLE = {
  margin: 22,

  // targets per state (we lerp smoothly to these)
  open:   { font: 16, tracking: 0.5,  lh: 1.35, alpha: 0.22 }, // bigger font when open
  semi:   { font: 13, tracking: 0.4,  lh: 1.35, alpha: 0.30 },
  closed: { font: 10, tracking: -1.2, lh: 1.15, alpha: 0.52 },
  none:   { font: 13, tracking: 0.4,  lh: 1.35, alpha: 0.24 },

  // smooth transitions
  smooth: 0.16,

  // polygon mask padding (px) baseline
  maskPad: 10,

  // dispersion (solo semi) - frenetic, but smoothed in render
  disperse: {
    damp: 0.88,
    maxSpeed: 70,
    noise: 18,
    rotNoise: 1.05,
    rotDamp: 0.86
  }
};

// current style (smoothed)
let curFont = TEXT_STYLE.semi.font;
let curTracking = TEXT_STYLE.semi.tracking;
let curLH = TEXT_STYLE.semi.lh;
let curAlpha = TEXT_STYLE.semi.alpha;

// ------------------------------------------------------------
// SETUP
// ------------------------------------------------------------

function setup() {
  // p5 overlay canvas (right panel)
  const holder = document.getElementById("canvas-holder");
  const box = holder.getBoundingClientRect();
  const c = createCanvas(Math.floor(box.width), Math.floor(box.height));
  c.parent("canvas-holder");
  pixelDensity(1);
  clear();

  // center canvas
  stageEl = document.getElementById("spaceStage");
  fieldCanvas = document.getElementById("space-canvas");
  fieldCtx = fieldCanvas.getContext("2d", { alpha: true });

  ensureSpaceToggleButton();
  resizeAll();

  initParticlesTo(FIELD.countSemi);
  layoutDirty = true;

  // Camera capture (hidden)
  videoP5 = createCapture({ video: { facingMode: "user" }, audio: false });
  videoP5.elt.setAttribute("playsinline", "");
  videoP5.hide();

  // MediaPipe Hands
  hands = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });
  hands.onResults(onResults);

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "Camera active. Move your hand.";

  window.addEventListener("resize", () => setTimeout(resizeAll, 0));
  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") showOverlay = !showOverlay;
  });

  lastSwitchMs = millis();
  stableState = "none";
  lastState = "none";
}

// ------------------------------------------------------------
// DRAW
// ------------------------------------------------------------

function draw() {
  // Send frame to MediaPipe (throttled)
  if (videoP5 && videoP5.elt && videoP5.elt.readyState >= 2 && !sending) {
    if (frameCount % 3 === 0) {
      sending = true;
      hands
        .send({ image: videoP5.elt })
        .then(() => (sending = false))
        .catch(() => (sending = false));
    }
  }

  // Overlay hand (p5 right panel)
  clear();
  if (showOverlay && handsData.length > 0) {
    push();
    translate(width, 0);
    scale(-1, 1);
    drawHand(handsData[0].lm);
    pop();
  }

  const lm = handsData.length > 0 ? handsData[0].lm : null;
  const lmNorm = handsData.length > 0 ? handsData[0].lmNorm : null;
  const g = lm ? featuresFromLandmarks(lm) : null;

  // Update focus from palm landmark (9). Mirror X for user-facing behavior.
  if (lmNorm && lmNorm[9]) {
    const fx = 1 - lmNorm[9].x;
    const fy = lmNorm[9].y;
    focus.x = clamp(fx, 0, 1);
    focus.y = clamp(fy, 0, 1);
  }

  // Smooth focus (reduces mask jitter)
  smFocusX = lerp(smFocusX, focus.x, 0.22);
  smFocusY = lerp(smFocusY, focus.y, 0.22);
  focusPx.x = smFocusX * cw;
  focusPx.y = smFocusY * ch;

  // Velocity in center frame (CSS pixels)
  if (prevFocusPx) {
    const dx = focusPx.x - prevFocusPx.x;
    const dy = focusPx.y - prevFocusPx.y;
    velSmooth.x = lerp(velSmooth.x, dx, 0.18);
    velSmooth.y = lerp(velSmooth.y, dy, 0.18);
  }
  prevFocusPx = { x: focusPx.x, y: focusPx.y };

  // Motion derived from focus velocity
  const vmag = Math.sqrt(velSmooth.x * velSmooth.x + velSmooth.y * velSmooth.y);
  const motionNorm = clamp(vmag / Math.max(1, cw * 0.12), 0, 1);
  motionSmooth = lerp(motionSmooth, motionNorm, 0.18);

  // No hand: neutral
  if (!g || !lm) {
    stableState = "none";
    lastState = "none";

    velSmooth.x = lerp(velSmooth.x, 0, 0.12);
    velSmooth.y = lerp(velSmooth.y, 0, 0.12);
    motionSmooth = lerp(motionSmooth, 0, 0.12);

    if (spaceMode === "particles") updateField("none", 0, false);
    else updateTextField("none", 0, false, null);

    updateStatus(null, "none", 0, motionSmooth);
    return;
  }

  // Gesture state and intensity
  const result = decideStateAndIntensity(g);
  lastState = result.state;


  // Stabilize to avoid flicker
  const now = millis();
  if (lastState !== stableState) {
    if (now - lastSwitchMs > HOLD_MS) {
      stableState = lastState;
      lastSwitchMs = now;
      layoutDirty = true;
    }
  } else {
    lastSwitchMs = now;
  }

  if (spaceMode === "particles") updateField(stableState, result.intensity, true);
  else updateTextField(stableState, result.intensity, true, lmNorm);

  updateStatus(g, stableState, result.intensity, motionSmooth);
}

// ------------------------------------------------------------
// MediaPipe results
// ------------------------------------------------------------

function onResults(results) {
  handsData = [];
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const lmRaw = results.multiHandLandmarks[0];

    // For overlay (right panel), use p5 canvas size
    const lm = lmRaw.map((p) => ({ x: p.x * width, y: p.y * height }));

    // Normalized 0..1 for mapping (center panel)
    const lmNorm = lmRaw.map((p) => ({ x: p.x, y: p.y, z: p.z }));

    handsData.push({ lm, lmNorm });

    // keep last good landmarks to bridge dropouts
    lastGoodLmNorm = lmNorm;
    lastGoodLmMs = performance.now();
  }
}

// ------------------------------------------------------------
// PARTICLES MODE: update + render (UNCHANGED)
// ------------------------------------------------------------

function updateField(state, intensity01, hasHand) {
  const k = clamp(intensity01, 0, 1);

  let targetCount = FIELD.countSemi;
  if (state === "open") targetCount = Math.floor(lerp(FIELD.countSemi, FIELD.countOpen, 0.75 + 0.25 * k));
  else if (state === "closed") targetCount = Math.floor(lerp(FIELD.countSemi, FIELD.countClosed, 0.75 + 0.25 * k));
  else if (state === "none") targetCount = Math.floor(FIELD.countSemi * 0.6);

  adjustPopulationTo(targetCount);

  const minDim = Math.min(cw, ch);
  const hx = focusPx.x;
  const hy = focusPx.y;

  let voidR = FIELD.voidRadiusSemi;
  let repulse = FIELD.repulseSemi;
  let attract = 0;

  let nScale = FIELD.noiseScaleSemi;
  let nForce = FIELD.noiseForceSemi;

  let alpha = FIELD.ptAlphaSemi;

  if (state === "open") {
    voidR = FIELD.voidRadiusOpen;
    repulse = FIELD.repulseOpen;
    nScale = FIELD.noiseScaleOpen;
    nForce = lerp(FIELD.noiseForceOpen, FIELD.noiseForceOpen * 1.35, motionSmooth);
    alpha = FIELD.ptAlphaOpen;
  } else if (state === "semi") {
    voidR = FIELD.voidRadiusSemi;
    repulse = FIELD.repulseSemi;
    nScale = FIELD.noiseScaleSemi;
    nForce = lerp(FIELD.noiseForceSemi * 0.9, FIELD.noiseForceSemi * 1.25, k) * (0.75 + 0.8 * motionSmooth);
    alpha = FIELD.ptAlphaSemi;
  } else if (state === "closed") {
    voidR = FIELD.voidRadiusClosed;
    repulse = 0;
    attract = FIELD.attractClosed;
    nScale = FIELD.noiseScaleClosed;
    nForce = FIELD.noiseForceClosed;
    alpha = FIELD.ptAlphaClosed;
  } else {
    voidR = FIELD.voidRadiusSemi;
    repulse = FIELD.repulseSemi * 0.35;
    nScale = FIELD.noiseScaleOpen;
    nForce = FIELD.noiseForceOpen * 0.55;
    alpha = FIELD.ptAlphaOpen * 0.85;
  }

  const voidRadiusPx = voidR * minDim;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];

    applyNoiseForce(p, nScale, nForce);

    if (hasHand) {
      applyHandFieldParticles(p, hx, hy, voidRadiusPx, repulse, attract);
    }

    if (state === "closed") {
      const cx = cw * 0.5;
      const cy = ch * 0.5;
      const dx = cx - p.x;
      const dy = cy - p.y;
      p.vx += dx * FIELD.compressClosed;
      p.vy += dy * FIELD.compressClosed;
    }

    p.vx *= FIELD.velDamp;
    p.vy *= FIELD.velDamp;

    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp > FIELD.maxSpeed) {
      const kk = FIELD.maxSpeed / sp;
      p.vx *= kk;
      p.vy *= kk;
    }

    p.x += p.vx;
    p.y += p.vy;

    wrapParticle(p);
  }

  renderParticles(alpha);
}

function renderParticles(alpha01) {
  if (!fieldCtx) return;

  fieldCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fieldCtx.clearRect(0, 0, cw, ch);
  fieldCtx.fillStyle = FIELD.bg;
  fieldCtx.fillRect(0, 0, cw, ch);

  const a = clamp(alpha01, 0.02, 0.6);
  fieldCtx.fillStyle = `rgba(15,15,15,${a})`;

  const s = Math.max(1, Math.floor(FIELD.ptSize));
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    fieldCtx.fillRect(p.x, p.y, s, s);
  }
}

function initParticlesTo(n) {
  particles = [];
  for (let i = 0; i < n; i++) {
    particles.push(makeParticle(Math.random() * cw, Math.random() * ch));
  }
}

function adjustPopulationTo(target) {
  const cur = particles.length;
  if (cur < target) {
    const add = Math.min(FIELD.spawnPerFrame, target - cur);
    for (let i = 0; i < add; i++) {
      particles.push(makeParticle(Math.random() * cw, Math.random() * ch));
    }
  } else if (cur > target) {
    const kill = Math.min(FIELD.killPerFrame, cur - target);
    for (let i = 0; i < kill; i++) {
      const idx = Math.floor(Math.random() * particles.length);
      particles[idx] = particles[particles.length - 1];
      particles.pop();
    }
  }
}

function makeParticle(x, y) {
  return {
    x,
    y,
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5
  };
}

function wrapParticle(p) {
  const m = FIELD.wrapMargin;
  if (p.x < -m) p.x = cw + m;
  if (p.x > cw + m) p.x = -m;
  if (p.y < -m) p.y = ch + m;
  if (p.y > ch + m) p.y = -m;
}

function applyNoiseForce(p, scale, strength) {
  const t = frameCount * 0.006;
  const n = noise(p.x * scale, p.y * scale, t);
  const ang = n * Math.PI * 4.0;
  const m = 0.06 * strength;
  p.vx += Math.cos(ang) * m;
  p.vy += Math.sin(ang) * m;
}

function applyHandFieldParticles(p, hx, hy, radiusPx, repulseStrength, attractStrength) {
  const dx = p.x - hx;
  const dy = p.y - hy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.0001) return;

  const t = clamp(1 - d / Math.max(1, radiusPx), 0, 1);
  const ease = t * t * (3 - 2 * t);

  if (repulseStrength > 0) {
    const k = ease * ease * repulseStrength * (0.75 + 0.55 * motionSmooth);
    p.vx += (dx / d) * k;
    p.vy += (dy / d) * k;
  }

  if (attractStrength > 0) {
    const k = ease * attractStrength;
    p.vx += (-dx) * 0.00115 * k;
    p.vy += (-dy) * 0.00115 * k;
  }
}

// ------------------------------------------------------------
// TEXT MODE: reflow around hand-shaped polygon + semi dispersion
// ------------------------------------------------------------

function updateTextField(state, intensity01, hasHand, lmNorm) {
  const k = clamp(intensity01, 0, 1);

  // pick target style per state
  const tgt = (state === "open") ? TEXT_STYLE.open
            : (state === "semi") ? TEXT_STYLE.semi
            : (state === "closed") ? TEXT_STYLE.closed
            : TEXT_STYLE.none;

  // smooth typography (no snapping)
  const s = TEXT_STYLE.smooth;
  curFont = lerp(curFont, tgt.font, s);
  curTracking = lerp(curTracking, tgt.tracking, s);
  curLH = lerp(curLH, tgt.lh, s);
  curAlpha = lerp(curAlpha, tgt.alpha, s);

  // choose landmarks to use (bridge dropouts)
  let useLm = lmNorm;
  if (!useLm) {
    const age = performance.now() - lastGoodLmMs;
    if (lastGoodLmNorm && age < LM_HOLD_MS) useLm = lastGoodLmNorm;
  }

  // build hand polygon mask only for open/closed
  let mask = null;
  if (hasHand && useLm && (state === "open" || state === "closed")) {
    let padBase;
    if (state === "open") padBase = TEXT_STYLE.maskPad + 100;
    else padBase = TEXT_STYLE.maskPad - 2; // smaller for closed

    const padPx = padBase * (0.85 + 0.20 * k);
    mask = buildHandPolygonMask(useLm, padPx);
  }

  // Decide if we rebuild layout
  const nowMs = performance.now();
  const bbox = maskBBox(mask);

  const moved = bboxMovedEnough(bbox, lastMaskBBox, MASK_MOVE_PX);
  const timeOk = (nowMs - lastLayoutMs) > LAYOUT_MIN_MS;

  const sig = [
    Math.round(curFont * 10),
    Math.round(curTracking * 10),
    Math.round(curLH * 100),
    state,
    mask ? 1 : 0
  ].join("|");

  const typoChanged = (sig !== lastLayoutSig);
  const maskAppearedOrGone = (!!mask !== hadMaskLast);

  const needLayout =
    layoutDirty ||
    typoChanged ||
    maskAppearedOrGone ||
    (mask && moved && timeOk);

  if (needLayout) {
    textChars = layoutTextWithObstacle(
      (textContent && textContent.length) ? textContent : DEFAULT_TEXT,
      curFont,
      curTracking,
      curLH,
      mask
    );

    layoutDirty = false;
    lastLayoutSig = sig;
    hadMaskLast = !!mask;
    lastMaskBBox = bbox;
    lastLayoutMs = nowMs;
  }

  // Semi: dispersion on top of stable layout
  if (state === "semi" && hasHand) {
    applySemiDispersion(textChars, k);
} else {
    // recover to clean layout (leggero e stabile)
    for (let i = 0; i < textChars.length; i++) {
      const p = textChars[i];
  
      p.vx *= 0.75;
      p.vy *= 0.75;
  
      p.ox = lerp(p.ox || 0, 0, 0.10);
      p.oy = lerp(p.oy || 0, 0, 0.10);
  
      p.sox = lerp(p.sox || 0, 0, 0.14);
      p.soy = lerp(p.soy || 0, 0, 0.14);
  
      p.rv *= 0.75;
      p.rot = lerp(p.rot || 0, 0, 0.10);
      p.srot = lerp(p.srot || 0, 0, 0.14);
  
      p.a = lerp(p.a ?? 1, 1, 0.08);
    }
  }
  

  renderTextChars(curAlpha, curFont, state);
}

function renderTextChars(alpha, fontSize, state) {
    if (!fieldCtx) return;
  
    fieldCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fieldCtx.clearRect(0, 0, cw, ch);
    fieldCtx.fillStyle = "#ffffff";
    fieldCtx.fillRect(0, 0, cw, ch);
  
    const baseA = clamp(alpha, 0.06, 0.78);
  
    fieldCtx.font = `${fontSize}px GambarinoWeb, serif`;
    fieldCtx.textBaseline = "alphabetic";
    fieldCtx.textAlign = "left";
  
    // In semi: dimezza il numero di draw per frame (riduce molto il lag)
    const strideDraw = (state === "semi") ? 2 : 1;
    const startDraw = (state === "semi") ? (frameCount % strideDraw) : 0;
  
    // Rotazioni: molto più rare in semi (save/restore costa tanto)
    const rotate = (state === "semi");
    const rotStride = rotate
      ? ((textChars.length > 12000) ? 18 : 12)
      : 0;
  
    for (let i = startDraw; i < textChars.length; i += strideDraw) {
      const p = textChars[i];
  
      const aa = clamp(baseA * (p.a ?? 1), 0.02, 0.90);
      fieldCtx.fillStyle = `rgba(15,15,15,${aa})`;
  
      const ox = rotate ? (p.sox || 0) : (p.ox || 0);
      const oy = rotate ? (p.soy || 0) : (p.oy || 0);
  
      const px = p.x + ox;
      const py = p.y + oy;
  
      if (rotate && (i % rotStride === 0)) {
        fieldCtx.save();
        fieldCtx.translate(px, py);
        fieldCtx.rotate((p.srot || 0));
        fieldCtx.fillText(p.ch, 0, 0);
        fieldCtx.restore();
      } else {
        fieldCtx.fillText(p.ch, px, py);
      }
    }
  }
  

// ------------------------------------------------------------
// Layout around polygon obstacle using two segments per line
// ------------------------------------------------------------

function layoutTextWithObstacle(text, fontSizePx, trackingPx, lineHMult, mask) {
    if (!fieldCtx) return [];
  
    const margin = TEXT_STYLE.margin;
    const maxW = Math.max(1, cw - margin * 2);
    const maxH = Math.max(1, ch - margin * 2);
  
    fieldCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fieldCtx.font = `${fontSizePx}px GambarinoWeb, serif`;
    fieldCtx.textBaseline = "alphabetic";
    fieldCtx.textAlign = "left";
  
    const lineH = Math.max(1, fontSizePx * lineHMult);
    const baselineOffset = lineH * 0.78;
  
    // --- stima iniziale (come prima, ma non definitiva)
    const area = maxW * maxH;
    const approxCharArea = Math.max(18, fontSizePx * fontSizePx * lineHMult * 0.62);
  
    // Con maschera attiva serve quasi sempre più testo (meno area utile e più “spreco” tra segmenti)
    const maskPenalty = mask ? 1.35 : 1.10;
  
    const needed = Math.ceil((area / approxCharArea) * 1.45 * maskPenalty);
  
    // limiti di sicurezza
    const MIN_CAP = 14000;
    const MAX_CAP = 90000;
  
    // funzione che esegue realmente il layout fino a un limite dato
    function layoutCore(limit) {
      const out = [];
  
      let y = margin + baselineOffset;
      let line = 0;
  
      let segL0 = margin, segL1 = margin + maxW;
      let segR0 = margin, segR1 = margin + maxW;
      let cursorSeg = 0;
      let x = margin;
  
      function computeSegmentsForY(baselineY) {
        const left = margin;
        const right = margin + maxW;
  
        let L0 = left, L1 = right;
        let R0 = right, R1 = right;
  
        if (mask && mask.poly && mask.poly.length >= 3) {
          const cy = baselineY - fontSizePx * 0.55;
          const xs = polygonScanlineIntersections(mask.poly, cy);
  
          if (xs.length >= 2) {
            const x0 = xs[0] - (mask.pad || 0);
            const x1 = xs[xs.length - 1] + (mask.pad || 0);
  
            const cutL = clamp(x0, left, right);
            const cutR = clamp(x1, left, right);
  
            if (cutR > cutL + 2) {
              L0 = left;
              L1 = cutL;
              R0 = cutR;
              R1 = right;
            }
          }
        }
  
        return { L0, L1, R0, R1 };
      }
  
      function newLine() {
        y += lineH;
        line++;
        if (y > margin + maxH) return false;
  
        const segs = computeSegmentsForY(y);
        segL0 = segs.L0; segL1 = segs.L1;
        segR0 = segs.R0; segR1 = segs.R1;
  
        const minUsable = Math.max(10, fontSizePx * 0.9);
        const leftUsable = (segL1 - segL0) >= minUsable;
        cursorSeg = leftUsable ? 0 : 1;
        x = (cursorSeg === 0) ? segL0 : segR0;
        return true;
      }
  
      // init first line segments
      {
        const segs = computeSegmentsForY(y);
        segL0 = segs.L0; segL1 = segs.L1;
        segR0 = segs.R0; segR1 = segs.R1;
  
        const minUsable = Math.max(10, fontSizePx * 0.9);
        const leftUsable = (segL1 - segL0) >= minUsable;
        cursorSeg = leftUsable ? 0 : 1;
        x = (cursorSeg === 0) ? segL0 : segR0;
      }
  
      for (let i = 0; i < limit; i++) {
        if (y > margin + maxH) break;
  
        let chh = text[i % text.length];
  
        if (chh === "\n") {
          if (!newLine()) break;
          continue;
        }
        if (chh === "\t") chh = " ";
  
        const w = measureCharWidthLocal(chh, fontSizePx);
        const adv = w + trackingPx;
  
        let seg0 = (cursorSeg === 0) ? segL0 : segR0;
        let seg1 = (cursorSeg === 0) ? segL1 : segR1;
  
        if (seg1 - seg0 < 2) {
          if (cursorSeg === 0 && segR1 - segR0 > 2) {
            cursorSeg = 1;
            seg0 = segR0; seg1 = segR1;
            x = seg0;
          } else {
            if (!newLine()) break;
            if (chh === " ") continue;
            seg0 = (cursorSeg === 0) ? segL0 : segR0;
            seg1 = (cursorSeg === 0) ? segL1 : segR1;
          }
        }
  
        if (x + adv > seg1) {
          if (cursorSeg === 0 && segR1 - segR0 > 2) {
            cursorSeg = 1;
            seg0 = segR0; seg1 = segR1;
            x = seg0;
  
            if (x + adv > seg1) {
              if (!newLine()) break;
              if (chh === " ") continue;
            }
          } else {
            if (!newLine()) break;
            if (chh === " ") continue;
          }
        }
  
        out.push({
          ch: chh,
          x,
          y,
          w,
          line,
          a: 1,
          ox: 0,
          oy: 0,
          vx: 0,
          vy: 0,
          rot: 0,
          rv: 0,
          sox: 0,
          soy: 0,
          srot: 0
        });
  
        x += adv;
      }
  
      return out;
    }
  
    // --- hardLimit adattivo: se finiamo troppo presto, aumentiamo e rilanciamo
    let limit = Math.max(MIN_CAP, Math.min(needed, MAX_CAP));
    let out = layoutCore(limit);
  
    // target: arrivare vicino al fondo (lasciamo un pelo di margine per evitare oscillazioni)
    const targetY = margin + maxH - lineH * 0.65;
  
    // Se non siamo arrivati in basso e abbiamo saturato il limite, aumentiamo e riproviamo (max 2 retry)
    for (let tries = 0; tries < 2; tries++) {
      const lastY = out.length ? out[out.length - 1].y : 0;
      const saturated = (out.length >= limit - 2);
  
      if (lastY >= targetY || !saturated) break;
  
      limit = Math.min(MAX_CAP, Math.floor(limit * 1.35));
      out = layoutCore(limit);
    }
  
    return out;
  }
  

function measureCharWidthLocal(chh, fontSizePx) {
  if (!fieldCtx) return Math.max(1, fontSizePx * 0.33);
  if (chh === " ") return Math.max(1, fontSizePx * 0.33);
  const m = fieldCtx.measureText(chh);
  return Math.max(0.5, m.width);
}

// ------------------------------------------------------------
// Semi dispersion (frenetic, but with render smoothing)
// ------------------------------------------------------------

function applySemiDispersion(chars, intensityK) {
    const D = TEXT_STYLE.disperse;
  
    const chaos = (0.45 + 1.10 * intensityK) * (0.60 + 1.20 * motionSmooth);
  
    const margin = TEXT_STYLE.margin;
    const minX = margin, maxX = cw - margin;
    const minY = margin, maxY = ch - margin;
  
    const spanX = Math.max(10, maxX - minX);
    const spanY = Math.max(10, maxY - minY);
  
    const kick = D.noise * chaos;
    const burst = 1 + Math.floor(2 * chaos); // 1..3
  
    // wrap morbido
    const wrapPad = 80;
    const minXw = minX - wrapPad, maxXw = maxX + wrapPad;
    const minYw = minY - wrapPad, maxYw = maxY + wrapPad;
    const wrapSpanX = spanX + wrapPad * 2;
    const wrapSpanY = spanY + wrapPad * 2;
  
    // performance: aggiorna solo 1/3 delle lettere per frame
    const stride = 3;
    const start = frameCount % stride;
  
    for (let i = start; i < chars.length; i += stride) {
      const p = chars[i];
  

    // Raffiche random
    for (let b = 0; b < burst; b++) {
      p.vx += (Math.random() - 0.5) * kick;
      p.vy += (Math.random() - 0.5) * kick;
    }

    // Turbolenza coerente (meno “jitter”, più “panico” fluido)
    const h1 = Math.sin((i * 12.9898 + frameCount * 0.37) * 0.07);
    const h2 = Math.cos((i * 78.233  + frameCount * 0.41) * 0.07);
    p.vx += h1 * kick * 0.85;
    p.vy += h2 * kick * 0.85;    

    // Smorzamento
    p.vx *= D.damp;
    p.vy *= D.damp;

    // Cap velocità
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp > D.maxSpeed) {
      const kk = D.maxSpeed / sp;
      p.vx *= kk;
      p.vy *= kk;
    }

    // Integra offset
    p.ox += p.vx;
    p.oy += p.vy;

    // Wrap su tutta l’area utile, con pad per ridurre scatti
    let px = p.x + p.ox;
    let py = p.y + p.oy;

    if (px < minXw) p.ox += wrapSpanX;
    else if (px > maxXw) p.ox -= wrapSpanX;

    if (py < minYw) p.oy += wrapSpanY;
    else if (py > maxYw) p.oy -= wrapSpanY;

    // Rotazione più nervosa
    const rn = D.rotNoise * (0.6 + 1.2 * chaos);
    p.rv += (Math.random() - 0.5) * rn;
    p.rv *= D.rotDamp;
    p.rot += p.rv;

    // Smoothing render, elimina effetto “taggato”
    const smooth = 0.22; // 0.15..0.30
    p.sox = lerp(p.sox || 0, p.ox, smooth);
    p.soy = lerp(p.soy || 0, p.oy, smooth);
    p.srot = lerp(p.srot || 0, p.rot, smooth);

    // Opacità leggermente instabile
    p.a = lerp(p.a, 0.78, 0.12);
  }
}

// ------------------------------------------------------------
// Hand-shaped polygon mask (convex hull + radial inflate)
// ------------------------------------------------------------

function buildHandPolygonMask(lmNorm, padPx) {
  if (!lmNorm || lmNorm.length < 21) return null;

  const pts = [];
  for (let i = 0; i < lmNorm.length; i++) {
    const p = lmNorm[i];
    const x = (1 - p.x) * cw; // mirror X
    const y = p.y * ch;
    pts.push({ x, y });
  }

  const hull = convexHull(pts);
  if (!hull || hull.length < 3) return null;

  const c = polygonCentroid(hull);
  const inflated = inflatePolygonFromCenter(hull, c, padPx);

  return { poly: inflated, pad: padPx };
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 2) return pts;

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function polygonCentroid(poly) {
  let x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    x += poly[i].x;
    y += poly[i].y;
  }
  const n = Math.max(1, poly.length);
  return { x: x / n, y: y / n };
}

function inflatePolygonFromCenter(poly, c, padPx) {
  let avgR = 0;
  for (let i = 0; i < poly.length; i++) {
    const dx = poly[i].x - c.x;
    const dy = poly[i].y - c.y;
    avgR += Math.sqrt(dx * dx + dy * dy);
  }
  avgR = avgR / Math.max(1, poly.length);
  const s = 1 + padPx / Math.max(30, avgR);

  const out = [];
  for (let i = 0; i < poly.length; i++) {
    out.push({
      x: c.x + (poly[i].x - c.x) * s,
      y: c.y + (poly[i].y - c.y) * s
    });
  }
  return out;
}

function polygonScanlineIntersections(poly, y) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];

    if (Math.abs(a.y - b.y) < 1e-6) continue;

    const ymin = Math.min(a.y, b.y);
    const ymax = Math.max(a.y, b.y);

    if (y >= ymin && y < ymax) {
      const t = (y - a.y) / (b.y - a.y);
      const x = a.x + t * (b.x - a.x);
      xs.push(x);
    }
  }
  xs.sort((u, v) => u - v);
  return xs;
}

// bbox helpers (reflow throttling)
function maskBBox(mask) {
  if (!mask || !mask.poly || mask.poly.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < mask.poly.length; i++) {
    const p = mask.poly[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5 };
}

function bboxMovedEnough(a, b, thr) {
  if (!a || !b) return true;
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return (dx * dx + dy * dy) > (thr * thr);
}

// ------------------------------------------------------------
// Gesture features + classification
// ------------------------------------------------------------

function featuresFromLandmarks(lm) {
  const wrist = lm[0];
  const d = (a, b) => dist(a.x, a.y, b.x, b.y);

  const palmSize = d(lm[0], lm[9]);

  function fingerExtendScore(tipIdx, pipIdx) {
    const tip = lm[tipIdx];
    const pip = lm[pipIdx];
    return (d(tip, wrist) - d(pip, wrist)) / Math.max(1, palmSize);
  }

  const idxN = fingerExtendScore(8, 6);
  const midN = fingerExtendScore(12, 10);
  const ringN = fingerExtendScore(16, 14);
  const pinkN = fingerExtendScore(20, 18);

  const thumbTip = lm[4];
  const thumbMcp = lm[2];
  const thumbOpen = d(thumbTip, thumbMcp) / Math.max(1, palmSize);

  const extAvg = (idxN + midN + ringN + pinkN) / 4;

  return { palmSize, thumbOpen, idxN, midN, ringN, pinkN, extAvg };
}

function decideStateAndIntensity(g) {
  const EXT_ON = 0.06;
  const EXT_OFF = 0.015;

  const fingers = [g.idxN, g.midN, g.ringN, g.pinkN];
  const extendedCount = fingers.filter((v) => v > EXT_ON).length;
  const foldedCount = fingers.filter((v) => v < EXT_OFF).length;

  const open = clamp(map01(g.extAvg, 0.02, 0.10), 0, 1);

  const openI = clamp(open, 0, 1);
  const closedI = clamp(1 - open, 0, 1);
  const semiI = clamp(1 - Math.abs(open - 0.5) * 2, 0, 1);

  if (foldedCount >= 3 && g.extAvg < 0.03 && g.thumbOpen < 0.7 && open < 0.28) {
    return { state: "closed", intensity: closedI };
  }
  if (extendedCount >= 3 && g.extAvg > 0.07 && open > 0.72) {
    return { state: "open", intensity: openI };
  }
  return { state: "semi", intensity: semiI };
}

// ------------------------------------------------------------
// Hand drawing (p5 overlay)
// ------------------------------------------------------------

function drawHand(lm) {
  stroke(20, 20, 20, 220);
  strokeWeight(1.6);
  noFill();

  const chains = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20]
  ];

  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = lm[chain[i]];
      const b = lm[chain[i + 1]];
      line(a.x, a.y, b.x, b.y);
    }
  }

  noStroke();
  fill(20, 20, 20, 235);
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    const r = i === 4 || i === 8 || i === 12 || i === 16 || i === 20 ? 4 : 3;
    circle(p.x, p.y, r * 2);
  }
}

// ------------------------------------------------------------
// UI: toggle button inside space
// ------------------------------------------------------------

function ensureSpaceToggleButton() {
  stageEl = document.getElementById("spaceStage");
  if (!stageEl) return;

  let btn = document.getElementById("spaceToggle");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "spaceToggle";
    btn.type = "button";
    stageEl.appendChild(btn);

    btn.style.position = "absolute";
    btn.style.left = "12px";
    btn.style.top = "12px";
    btn.style.zIndex = "10";
    btn.style.border = "1px solid #bdbdbd";
    btn.style.background = "rgba(255,255,255,0.92)";
    btn.style.padding = "6px 10px";
    btn.style.fontSize = "12px";
    btn.style.cursor = "pointer";
    btn.style.color = "#111";
  }

  btn.textContent = "Switch";

  btn.onclick = () => {
    spaceMode = spaceMode === "particles" ? "text" : "particles";
    btn.textContent = "Switch";

    if (spaceMode === "particles") {
      renderParticles(FIELD.ptAlphaSemi);
    } else {
      layoutDirty = true;
      updateTextField("none", 0, false, null);
    }
  };
}

// ------------------------------------------------------------
// Status + resize + utilities
// ------------------------------------------------------------
function emotionFromGestureState(state) {
  if (state === "open") return "joy";
  if (state === "semi") return "sadness";
  if (state === "closed") return "fear";
  return "neutral";
}


function updateStatus(g, state, intensity, motionVal) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  const modeLabel = spaceMode === "particles" ? "particles" : "text";
  const emotion = emotionFromGestureState(state);

  if (!g) {
    statusEl.textContent = `Mode: ${modeLabel} | State: none | emotion: ${emotion} | intensity: 0.00 | motion: ${motionVal.toFixed(2)}`;
    return;
  }

  statusEl.textContent =
    `Mode: ${modeLabel} | State: ${state} | emotion: ${emotion} | intensity: ${intensity.toFixed(2)} | motion: ${motionVal.toFixed(2)}`;
}

function resizeAll() {
  // Resize p5 overlay canvas
  const holder = document.getElementById("canvas-holder");
  if (holder) {
    const box = holder.getBoundingClientRect();
    resizeCanvas(Math.floor(box.width), Math.floor(box.height));
  }

  // Resize center canvas
  stageEl = document.getElementById("spaceStage");
  if (!stageEl || !fieldCanvas) return;

  const r = stageEl.getBoundingClientRect();
  const newCw = Math.max(1, Math.floor(r.width));
  const newCh = Math.max(1, Math.floor(r.height));

  dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

  fieldCanvas.width = newCw * dpr;
  fieldCanvas.height = newCh * dpr;
  fieldCanvas.style.width = `${newCw}px`;
  fieldCanvas.style.height = `${newCh}px`;

  fieldCtx = fieldCanvas.getContext("2d", { alpha: true });

  // Remap existing particles to new size
  if (cw > 1 && ch > 1) {
    const sx = newCw / cw;
    const sy = newCh / ch;

    for (let i = 0; i < particles.length; i++) {
      particles[i].x *= sx;
      particles[i].y *= sy;
      particles[i].vx *= sx;
      particles[i].vy *= sy;
    }
  }

  cw = newCw;
  ch = newCh;

  // Keep focus coherent after resize
  focusPx.x = focus.x * cw;
  focusPx.y = focus.y * ch;
  prevFocusPx = { x: focusPx.x, y: focusPx.y };

  smFocusX = focus.x;
  smFocusY = focus.y;

  // reset layout throttling state
  lastMaskBBox = null;
  lastLayoutMs = 0;
  lastLayoutSig = "";
  hadMaskLast = false;

  layoutDirty = true;

  if (spaceMode === "particles") renderParticles(FIELD.ptAlphaSemi);
  else updateTextField("none", 0, false, null);
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function map01(x, inMin, inMax) {
  if (inMax - inMin === 0) return 0;
  return (x - inMin) / (inMax - inMin);
}
