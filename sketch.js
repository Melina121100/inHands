// =========================
// Hand Gestures: points + dynamic poem scroll + motion-triggered background shifts
//
// Stati principali (gesture -> montaggio emotivo):
// - Open hand     -> gioia (blocchi joy coesi, altri dispersi)
// - Semi-closed   -> tristezza (blocchi sad coesi, altri dispersi)
// - Closed fist   -> paura (blocchi fear coesi, altri dispersi)
// - No hand       -> neutro
//
// Extra:
// - Il colore di sfondo cambia SOLO in base al movimento spaziale della mano.
// - Se non viene rilevata alcuna mano, lo sfondo torna bianco.
// - I blocchi non attivi restano visibili, con letter-spacing aumentato e lettere che vagano nello spazio.
// - Transizioni rallentate: la disgregazione quando cambia gesto è più lenta e “respirata”.
// =========================

let videoP5;
let hands;
let sending = false;

let handsData = [];
let showOverlay = true;

let bgCurrent = { r: 255, g: 255, b: 255 };
let bgTarget  = { r: 255, g: 255, b: 255 };

// Stabilizzazione stato
let lastState = "none";
let stableState = "none";
let lastSwitchMs = 0;
const HOLD_MS = 160;

// Scroll testo
let poemScrollEl;
let poemInnerEl;

let loopOffset = 0; // 0..singleHeight
let singleHeight = 0; // altezza di UNA copia del testo (in px)
let speed = 0; // px per frame (normalizzato con deltaTime)
let targetSpeed = 0;

// Tipografia dinamica (globale)
let curLineHeight = 1.15;
let curLetterSpacing = 0; // fallback globale
let targetLineHeight = 1.15;
let targetLetterSpacing = 0;

// Movimento: percezione continua
let prevLm = null;
let prevOpen = null; // mantenuto ma non usato per trigger
let motionSmooth = 0; // 0..1 smussato
let prevMotionSmooth = 0;

// Sfondo: elemento target
let pageEl = null;

// Variazioni discrete di sfondo
let motionArmed = true;
const MOTION_ON = 0.12;   // soglia per scatto
const MOTION_OFF = 0.07;  // soglia per riarmare (più bassa)
const BG_PALETTE = ["#ffffff", "#edf6ff", "#fff0f5", "#effff4", "#fff7e8"];
let bgIndex = 0;
let lastBgSwitchMs = 0;
const BG_COOLDOWN_MS = 260;
const MOTION_TRIGGER = 0.12;

// Testo: Neruda, a blocchi emotivi
const POEM_BLOCKS = [
  {
    id: "A",
    emotion: "sad",
    text: `We have lost even this twilight.
No one saw us this evening hand in hand
while the blue night dropped on the world.`
  },
  {
    id: "B",
    emotion: "joy",
    text: `I have seen from my window
the fiesta of sunset in the distant mountain tops.
Sometimes a piece of sun
burned like a coin in my hand.`
  },
  {
    id: "C",
    emotion: "sad",
    text: `I remembered you with my soul clenched
in that sadness of mine that you know.`
  },
  {
    id: "D",
    emotion: "fear",
    text: `Where were you then??
Who else was there?
Saying what?`
  },
  {
    id: "E",
    emotion: "sad",
    text: `Why will the whole of love come on me suddenly
when I am sad and feel you are far away?`
  },
  {
    id: "F",
    emotion: "fear",
    text: `The book fell that always closed at twilight
and my blue sweater rolled like a hurt dog at my feet`
  },
  {
    id: "G",
    emotion: "sad",
    text: `Always, always you recede through the evenings
toward the twilight erasing statues. `
  }
];

// DOM poem: caratteri e blocchi
let poemChars = [];     // { el, seedA, seedB, f1, f2, baseEmotion, blockId, cohesion }
let poemBlocksEls = []; // { el, emotion, id }
let montage = { joy: 0, sad: 0, fear: 0 };

// Transizioni: rallentamento quando cambia gesture
let lastStableState = "none";

// Disegno mano
const COL = {
  points: [20, 20, 20],
  lines: [20, 20, 20]
};

function setup() {
  // Canvas overlay (mano)
  const holder = document.getElementById("canvas-holder");
  const box = holder.getBoundingClientRect();

  const c = createCanvas(Math.floor(box.width), Math.floor(box.height));
  c.parent("canvas-holder");
  pixelDensity(1);
  clear();

  // DOM testo
  poemScrollEl = document.getElementById("poemScroll");
  poemInnerEl = document.getElementById("poemInner");

  // Target sfondo: .page
  pageEl = document.querySelector(".page");

  // Costruisci testo come DOM a blocchi (doppia copia per loop infinito)
  if (poemInnerEl) buildPoemDOM();

  // Sfondo iniziale
  bgIndex = 0;
  setBackgroundColor(BG_PALETTE[bgIndex]);

  // Calcola altezze dopo layout
  setTimeout(() => {
    computePoemHeights();
    loopOffset = 0;
    applyPoemTransform();
    applyTypography(true);
  }, 0);

  // Camera attiva ma nascosta
  videoP5 = createCapture({ video: { facingMode: "user" }, audio: false });
  videoP5.elt.setAttribute("playsinline", "");
  videoP5.hide();

  // MediaPipe Hands
  hands = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });
  hands.onResults(onResults);

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "Camera active. Move hand to trigger background shifts.";

  window.addEventListener("resize", onResize);

  // Toggle overlay
  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") showOverlay = !showOverlay;
  });

  // Stato iniziale
  setPoemStateClass("none");
  setTypographyTargets("none");
  lastSwitchMs = millis();
}

function draw() {
  clear();
  updateBackgroundSmooth();
  // Invio frame throttled
  if (videoP5 && videoP5.elt && videoP5.elt.readyState >= 2 && !sending) {
    if (frameCount % 3 === 0) {
      sending = true;
      hands
        .send({ image: videoP5.elt })
        .then(() => (sending = false))
        .catch(() => (sending = false));
    }
  }

  // Debug minimo
  noStroke();
  fill(0);
  textSize(12);
  text(`hands: ${handsData.length}`, 10, 18);

  // Overlay mano
  if (showOverlay && handsData.length > 0) {
    push();
    translate(width, 0);
    scale(-1, 1);
    drawHand(handsData[0].lm);
    pop();
  }

  // Feature mano
  const lm = handsData.length > 0 ? handsData[0].lm : null;
  const g = lm ? featuresFromLandmarks(lm) : null;

  // Movimento continuo
  if (g && lm) {
    const m = computeMotion(lm, g);
    motionSmooth = lerp(motionSmooth, m, 0.12);
  } else {
    motionSmooth = lerp(motionSmooth, 0, 0.08);
    prevLm = null;
    prevOpen = null;
  }

  // Sfondo: scatti discreti solo se mano presente
  maybeSwitchBackgroundByMotion(!!g);

  // Se nessuna mano: sfondo bianco e stato none
  if (!g) {
    setBackgroundColor("#ffffff");
    bgIndex = 0;
    lastBgSwitchMs = millis();

    stableState = "none";
    setPoemStateClass("none");
    setTypographyTargets("none");

    applyMontageByGesture("none", 0, true);

    targetSpeed = 0.18;
    speed = lerp(speed, targetSpeed, 0.06);

    applyTypography(false);
    advanceScroll();

    updateStatus(null, "none", 0, motionSmooth);
    return;
  }

  // Stato + intensità
  const result = decideStateAndIntensity(g);
  lastState = result.state;

  // Stabilizzazione (evita flicker)
  const now = millis();
  if (lastState !== stableState) {
    if (now - lastSwitchMs > HOLD_MS) {
      stableState = lastState;
      lastSwitchMs = now;
    }
  } else {
    lastSwitchMs = now;
  }

  // Applica stato al container (classe)
  setPoemStateClass(stableState);

  // Tipografia target in base allo stato
  setTypographyTargets(stableState);

  // Transizione gesture?
  const isTransition = stableState !== lastStableState;
  lastStableState = stableState;

  // Montaggio emotivo a blocchi + deriva lettere (rallentata in transizione)
  applyMontageByGesture(stableState, result.intensity, isTransition);

  // Velocità target in base allo stato
  if (stableState === "open") targetSpeed = 0.60;
  else if (stableState === "semi") targetSpeed = 0.06;
  else if (stableState === "closed") targetSpeed = 0.24;
  else targetSpeed = 0.18;

  speed = lerp(speed, targetSpeed, 0.08);

  applyTypography(false);
  advanceScroll();

  updateStatus(g, stableState, result.intensity, motionSmooth);
}

function onResults(results) {
  handsData = [];
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const lmRaw = results.multiHandLandmarks[0];
    const lm = lmRaw.map((p) => ({ x: p.x * width, y: p.y * height }));
    handsData.push({ lm });
  }
}

// =========================
// Poem DOM builder + montage
// =========================

function buildPoemDOM() {
  poemInnerEl.innerHTML = "";
  poemChars = [];
  poemBlocksEls = [];

  const frag = document.createDocumentFragment();

  // Due copie per loop infinito
  for (let copy = 0; copy < 2; copy++) {
    for (const b of POEM_BLOCKS) {
      const blockEl = document.createElement("div");
      blockEl.className = "poem-block";
      blockEl.dataset.emotion = b.emotion;
      blockEl.dataset.blockId = b.id;

      // Default: tutto visibile
      blockEl.style.letterSpacing = "0px";
      blockEl.style.opacity = "1";

      // Una sola newline tra blocchi: gap gestito via CSS, non con righe vuote
      const text = b.text + "\n";
      const chars = Array.from(text);

      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];

        if (ch === "\n") {
          blockEl.appendChild(document.createElement("br"));
          continue;
        }

        if (ch === " ") {
          const sp = document.createElement("span");
          sp.className = "poem-space";
          sp.textContent = " ";
          blockEl.appendChild(sp);
          continue;
        }

        const s = document.createElement("span");
        s.className = "poem-char";
        s.textContent = ch;

        const r = mulberry32(hashInt(`${b.id}-${copy}-${i}`));
        const seedA = r();
        const seedB = r();
        const f1 = 0.35 + r() * 0.85;
        const f2 = 0.35 + r() * 0.85;

        poemChars.push({
          el: s,
          seedA,
          seedB,
          f1,
          f2,
          baseEmotion: b.emotion,
          blockId: b.id,
          cohesion: 1
        });

        blockEl.appendChild(s);
      }

      poemBlocksEls.push({ el: blockEl, emotion: b.emotion, id: b.id });
      frag.appendChild(blockEl);
    }
  }

  poemInnerEl.appendChild(frag);

  montage.joy = 0;
  montage.sad = 0;
  montage.fear = 0;

  computePoemHeights();
  applyPoemTransform();
}

function applyMontageByGesture(state, intensity01, isTransition) {
  // Target base sempre presente
  let target = { joy: 0.18, sad: 0.18, fear: 0.18 };

  if (state === "open") {
    target = { joy: 1.0, sad: 0.30, fear: 0.22 };
  } else if (state === "semi") {
    target = { joy: 0.22, sad: 1.0, fear: 0.25 };
  } else if (state === "closed") {
    target = { joy: 0.16, sad: 0.26, fear: 1.0 };
  } else {
    target = { joy: 0.18, sad: 0.18, fear: 0.18 };
  }

  // Intensità: più alta = più coeso il blocco attivo, più dispersi gli altri
  const k = clamp(intensity01, 0, 1);
  const boost = 0.28 * k;

  if (state === "open") {
    target.joy = clamp(target.joy + boost, 0, 1);
    target.sad = clamp(target.sad - boost * 0.7, 0, 1);
    target.fear = clamp(target.fear - boost * 0.7, 0, 1);
  } else if (state === "semi") {
    target.sad = clamp(target.sad + boost, 0, 1);
    target.joy = clamp(target.joy - boost * 0.7, 0, 1);
    target.fear = clamp(target.fear - boost * 0.7, 0, 1);
  } else if (state === "closed") {
    target.fear = clamp(target.fear + boost, 0, 1);
    target.joy = clamp(target.joy - boost * 0.7, 0, 1);
    target.sad = clamp(target.sad - boost * 0.7, 0, 1);
  }

  // Smooth del montaggio: più lento in generale, ancora più lento in transizione
  const MONTAGE_LERP_BASE = 0.04;
  const MONTAGE_LERP_TRANSITION = 0.025;
  const montageLerp = isTransition ? MONTAGE_LERP_TRANSITION : MONTAGE_LERP_BASE;

  montage.joy = lerp(montage.joy, target.joy, montageLerp);
  montage.sad = lerp(montage.sad, target.sad, montageLerp);
  montage.fear = lerp(montage.fear, target.fear, montageLerp);

  // Applica a blocchi: letterSpacing e opacity (sempre visibili)
  for (const b of poemBlocksEls) {
    const a = getEmotionActivation(b.emotion);

    // Spaziatura: non attivo più ampio, attivo coeso
    const letterSpacingPx = lerp(2.8, 0.0, a);
    b.el.style.letterSpacing = `${letterSpacingPx.toFixed(2)}px`;

    // Opacità: sempre presente, solo attenuata
    const op = lerp(0.62, 1.0, a);
    b.el.style.opacity = String(op.toFixed(3));

    // Forza line-height anche qui, per evitare override CSS
    b.el.style.setProperty("line-height", String(curLineHeight), "important");
  }

  // Deriva caratteri
  const t = millis() * 0.001;

  // Base wander per non attivo
  const baseWanderX = 18.0;
  const baseWanderY = 11.0;

  // Paura rende tutto più nervoso
  const fearDrive = montage.fear;

  // Smussatura per-lettera: in transizione è più lenta
  const COHESION_LERP_BASE = 0.05;
  const COHESION_LERP_TRANSITION = 0.025;
  const cohesionLerp = isTransition ? COHESION_LERP_TRANSITION : COHESION_LERP_BASE;

  for (let i = 0; i < poemChars.length; i++) {
    const c = poemChars[i];

    const a = getEmotionActivation(c.baseEmotion);
    c.cohesion = lerp(c.cohesion, a, cohesionLerp);
    const cohesion = c.cohesion;

    let wanderX = (1 - cohesion) * baseWanderX;
    let wanderY = (1 - cohesion) * baseWanderY;

    // In paura: leggermente più instabile, ma non esplode
    if (state === "closed") {
      wanderX *= 1.05;
      wanderY *= 1.08;
    }

    // Ponte E reagisce anche a joy e fear
    if (c.blockId === "E") {
      const extra = Math.max(montage.joy, montage.fear) * 0.30;
      wanderX *= 1 + extra;
      wanderY *= 1 + extra;
    }

    // Frequenze aumentano con paura
    const f1 = c.f1 * lerp(1.0, 2.0, fearDrive);
    const f2 = c.f2 * lerp(1.0, 1.85, fearDrive);

    const dx = Math.sin(t * f1 + c.seedA * 6.2831853) * wanderX;
    const dy = Math.cos(t * f2 + c.seedB * 6.2831853) * wanderY;

    c.el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
  }
}

function getEmotionActivation(emotion) {
  if (emotion === "joy") return montage.joy;
  if (emotion === "sad") return montage.sad;
  return montage.fear;
}

// RNG deterministico
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// =========================
// Feature robuste (dita estese/piegate)
// =========================
function featuresFromLandmarks(lm) {
  const wrist = lm[0];
  const d = (a, b) => dist(a.x, a.y, b.x, b.y);

  // scala mano: polso -> base dito medio
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

// =========================
// Movimento: SOLO movimento spaziale (no apertura/chiusura)
// =========================
function computeMotion(lm, g) {
  const d2 = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  let spatial = 0;

  if (prevLm) {
    // Punti più stabili: polso + basi dita
    const idxs = [0, 5, 9, 13, 17];
    let sum = 0;
    for (const i of idxs) sum += d2(lm[i], prevLm[i]);
    const avg = sum / idxs.length;

    spatial = avg / Math.max(1, g.palmSize);
  }

  prevLm = lm.map((p) => ({ x: p.x, y: p.y }));
  prevOpen = g.extAvg;

  // Moltiplicatore sensibilità
  const raw = spatial * 3.0;
  return clamp(raw, 0, 1);
}

// =========================
// Sfondo: scatti discreti a soglia + cooldown (solo con mano presente)
// =========================
function maybeSwitchBackgroundByMotion(handPresent) {
  const now = millis();

  if (!handPresent) {
    motionArmed = true;
    prevMotionSmooth = motionSmooth;
    return;
  }

  // Riarmo quando il movimento torna “calmo”
  if (motionSmooth < MOTION_OFF) {
    motionArmed = true;
  }

  // Scatto solo se armato e superi la soglia alta
  if (motionArmed && motionSmooth >= MOTION_ON && (now - lastBgSwitchMs) >= BG_COOLDOWN_MS) {
    motionArmed = false;
    lastBgSwitchMs = now;

    bgIndex = (bgIndex + 1) % BG_PALETTE.length;
    setBackgroundColor(BG_PALETTE[bgIndex]);
  }

  prevMotionSmooth = motionSmooth;
}


function setBackgroundColor(col) {
  const rgb = hexToRgb(col);
  bgTarget.r = rgb.r;
  bgTarget.g = rgb.g;
  bgTarget.b = rgb.b;
}

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  const bigint = parseInt(hex, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255
  };
}

function updateBackgroundSmooth() {
  const ease = 0.06; // 0.03 più lento, 0.1 più rapido

  bgCurrent.r += (bgTarget.r - bgCurrent.r) * ease;
  bgCurrent.g += (bgTarget.g - bgCurrent.g) * ease;
  bgCurrent.b += (bgTarget.b - bgCurrent.b) * ease;

  const r = Math.round(bgCurrent.r);
  const g = Math.round(bgCurrent.g);
  const b = Math.round(bgCurrent.b);

  const col = `rgb(${r}, ${g}, ${b})`;

  if (pageEl) pageEl.style.backgroundColor = col;
  document.body.style.backgroundColor = col;
}

// =========================
// Classificazione: stato + intensità
// =========================
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

  if (foldedCount >= 3 && g.extAvg < 0.03 && g.thumbOpen < 0.70 && open < 0.28) {
    return { state: "closed", intensity: closedI };
  }

  if (extendedCount >= 3 && g.extAvg > 0.07 && open > 0.72) {
    return { state: "open", intensity: openI };
  }

  return { state: "semi", intensity: semiI };
}

// =========================
// Testo: classi stato + scroll loop
// =========================
function setPoemStateClass(state) {
  if (!poemScrollEl) return;

  poemScrollEl.classList.remove("state-open", "state-semi", "state-closed", "state-none");

  if (state === "open") poemScrollEl.classList.add("state-open");
  else if (state === "semi") poemScrollEl.classList.add("state-semi");
  else if (state === "closed") poemScrollEl.classList.add("state-closed");
  else poemScrollEl.classList.add("state-none");
}

// Tipografia target per stato (globale)
function setTypographyTargets(state) {
  if (state === "open") {
    targetLineHeight = 1.18;
    targetLetterSpacing = 0;
    return;
  }

  if (state === "semi") {
    targetLineHeight = 1.08;
    targetLetterSpacing = 0.10;
    return;
  }

  if (state === "closed") {
    targetLineHeight = 1.02;
    targetLetterSpacing = 0.10;
    return;
  }

  targetLineHeight = 1.15;
  targetLetterSpacing = 0;
}

// Applica tipografia con transizione morbida
function applyTypography(immediate) {
  if (!poemInnerEl) return;

  if (immediate) {
    curLineHeight = targetLineHeight;
    curLetterSpacing = targetLetterSpacing;
  } else {
    curLineHeight = lerp(curLineHeight, targetLineHeight, 0.10);
    curLetterSpacing = lerp(curLetterSpacing, targetLetterSpacing, 0.10);
  }

  // Forza con priorità alta, evita override CSS
  poemInnerEl.style.setProperty("line-height", String(curLineHeight), "important");
  poemInnerEl.style.setProperty("letter-spacing", `${curLetterSpacing.toFixed(2)}px`, "important");

  // Forza anche sui blocchi (se esistono già)
  for (const b of poemBlocksEls) {
    b.el.style.setProperty("line-height", String(curLineHeight), "important");
  }

  computePoemHeights();
}

function computePoemHeights() {
  if (!poemInnerEl) return;
  const h = poemInnerEl.scrollHeight;
  singleHeight = Math.max(1, Math.floor(h / 2));
}

function advanceScroll() {
  if (!poemInnerEl) return;

  const dt = (typeof deltaTime === "number" ? deltaTime : 16.666) / 16.666;

  if (singleHeight <= 1) computePoemHeights();

  loopOffset += speed * dt;

  if (loopOffset >= singleHeight) loopOffset -= singleHeight;

  applyPoemTransform();
}

function applyPoemTransform() {
  if (!poemInnerEl) return;
  const y = -singleHeight + loopOffset;
  poemInnerEl.style.transform = `translateY(${y}px)`;
}

// =========================
// Disegno mano
// =========================
function drawHand(lm) {
  stroke(COL.lines[0], COL.lines[1], COL.lines[2], 220);
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
  fill(COL.points[0], COL.points[1], COL.points[2], 235);
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    const r = i === 4 || i === 8 || i === 12 || i === 16 || i === 20 ? 4 : 3;
    circle(p.x, p.y, r * 2);
  }
}

// =========================
// Status
// =========================

function emotionFromGestureState(state) {
  if (state === "open") return "joy";
  if (state === "semi") return "sadness";
  if (state === "closed") return "fear";
  return "neutral";
}

function updateStatus(g, state, intensity, motionVal) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  const emotion = emotionFromGestureState(state);

  if (!g) {
    statusEl.textContent = `State: none | emotion: ${emotion} | intensity: 0.00 | motion: ${motionVal.toFixed(2)}`;
    return;
  }

  statusEl.textContent =
    `State: ${state} | emotion: ${emotion} | intensity: ${intensity.toFixed(2)} | motion: ${motionVal.toFixed(2)}`;
}
// =========================
// Resize
// =========================
function onResize() {
  const holder = document.getElementById("canvas-holder");
  const box = holder.getBoundingClientRect();
  resizeCanvas(Math.floor(box.width), Math.floor(box.height));

  setTimeout(() => {
    computePoemHeights();
    applyPoemTransform();
  }, 0);
}

// =========================
// Utilities
// =========================
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function map01(x, inMin, inMax) {
  if (inMax - inMin === 0) return 0;
  return (x - inMin) / (inMax - inMin);
}
