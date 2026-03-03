// sketch.sound.js
// Clenched Soul – Sound dimension (streaming backend)
// Gesture-driven sound states: open / semi / closed / none
// Right panel shows ONLY skeleton (no camera video).

// ------------------------------------------------------------
// GLOBALS
// ------------------------------------------------------------
let videoP5, hands;
let sending = false;

let handsData = []; // [{ lmNorm:[{x,y,z}..21], handedness }]
let prevPalm = null;
let motionSmooth = 0;
let opennessSmooth = 0;
let curlSmooth = 0;
let energySmooth = 0;

let lastState = "none";
let stableState = "none";
let lastSwitchMs = 0;
const HOLD_MS = 140;

let camStarted = false;
let mpReady = false;

let analyser = null;
let analyserData = null;
let audioLevelSmooth = 0;

let blobRadii = [];
let blobMaxPoints = 240;

let scrollX = 0;
let patternSeed = 1337;

let joyDrift = [0, 0, 0];

function emotionFromGestureState(state) {
  if (state === "open") return "joy";
  if (state === "semi") return "sadness";
  if (state === "closed") return "fear";
  return "neutral";
}

function intensityFromState(state, open01, curl01) {
  if (state === "open") return constrain(open01, 0, 1);
  if (state === "closed") return constrain(curl01, 0, 1);
  if (state === "semi") {
    const mid = 1.0 - Math.abs(open01 - 0.5) * 2.0; // picco a open=0.5
    return constrain(mid, 0, 1);
  }
  return 0;
}

// UI
let statusEl, overlayEl, enableEl;

// Info layer
let infoLayer, openInfoBtn, closeInfoBtn, infoBackdrop, infoCard;

// Audio
let audioCtx = null;
let mediaEls = {};
let mediaSources = {};
let mediaGains = {};
let globalGain = null;
let filterNode = null;
let sndLoaded = false;
let audioReady = false;
let currentPlaying = null;
let visPausedDueToHidden = false;

const AUDIO_PATH = {
  open: "sound/allegro.mp3",
  semi: "sound/triste.mp3",
  closed: "sound/paura.mp3",
};

// Canvases
let soundCanvas;
let skelGfx;
let skelDomCanvas = null;
let skelDomCtx = null;

// ------------------------------------------------------------
// P5 SETUP / DRAW
// ------------------------------------------------------------
function setup() {
  // DOM
  statusEl = document.getElementById("status");
  overlayEl = document.getElementById("soundOverlay");
  enableEl = document.getElementById("soundEnable");

  infoLayer = document.getElementById("infoLayer");
  openInfoBtn = document.getElementById("openInfo");
  closeInfoBtn = document.getElementById("closeInfo");
  infoBackdrop = document.getElementById("infoBackdrop");
  infoCard = document.getElementById("infoCard");
  wireInfoLayer();

  // Canvas
  soundCanvas = createCanvas(10, 10);
  const holder = document.getElementById("sound-canvas-holder");
  if (holder) soundCanvas.parent(holder);

  skelGfx = createGraphics(10, 10);

  // Enable handler (button + overlay)
  const targets = [];
  if (enableEl) targets.push(enableEl);
  if (overlayEl) targets.push(overlayEl);

  const onEnable = async () => {
    try {
      if (statusEl) statusEl.textContent = "Enabling…";

      // Unlock audio (autoplay policy)
      if (typeof userStartAudio === "function") await userStartAudio();

      // Start camera + MediaPipe on user gesture
      if (!camStarted) {
        camStarted = true;
        await startCameraAndHands(320, 240);
      }

      // Start audio engine
      initStreamingEngine();
      audioReady = true;

      if (overlayEl) overlayEl.style.display = "none";
      if (statusEl) statusEl.textContent = "Show your hand";
    } catch (e) {
      console.error("Enable failed:", e);
      if (statusEl) statusEl.textContent = "Enable failed. Check console / permissions.";
    }
  };

  targets.forEach((el) => el.addEventListener("click", onEnable));

  window.addEventListener("resize", resizeAll);
  resizeAll();
}

function draw() {
  background(255);

  // Send frames to MediaPipe (throttled)
  if (mpReady && videoP5 && videoP5.elt && videoP5.elt.readyState >= 2 && hands && !sending) {
    if (frameCount % 2 === 0) {
      sending = true;
      hands
        .send({ image: videoP5.elt })
        .catch((e) => console.warn("hands.send failed:", e))
        .finally(() => {
          sending = false;
        });
    }
  }

  const detection = getBestHand();
  const hasHand = !!detection;

  let rawState = "none";
  let openVal = 0;
  let curlVal = 0;

  if (hasHand) {
    const lm = detection.lmNorm;

    openVal = estimateOpenness(lm);
    curlVal = estimateCurl(lm);

    // Riconoscimento "semi" più precoce
    rawState = classifyStateEarlySemi(lm, openVal, curlVal);

    // Motion energy
    const palm = lm[0];
    if (prevPalm) {
      const dx = palm.x - prevPalm.x;
      const dy = palm.y - prevPalm.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      motionSmooth = lerp(motionSmooth, constrain(d * 18.0, 0, 1), 0.18);
    }
    prevPalm = { x: palm.x, y: palm.y };
  } else {
    prevPalm = null;
    motionSmooth = lerp(motionSmooth, 0, 0.12);
  }

  opennessSmooth = lerp(opennessSmooth, openVal, 0.15);
  curlSmooth = lerp(curlSmooth, curlVal, 0.15);
  energySmooth = lerp(energySmooth, motionSmooth, 0.12);

  // Placeholder right panel
  const rightCenterText =
    document.getElementById("cameraCenterText") || document.getElementById("cameraPlaceholder");
  if (rightCenterText) rightCenterText.style.display = hasHand ? "none" : "block";

// Status (pulito): state + emotion + intensity + motion
if (statusEl) {
  const emotion = emotionFromGestureState(stableState);
  const intensity = intensityFromState(stableState, opennessSmooth, curlSmooth);
  const handsCount = hasHand ? 1 : 0;

  statusEl.textContent =
    `hands: ${handsCount} | State: ${stableState} | emotion: ${emotion} | intensity: ${intensity.toFixed(2)} | motion: ${motionSmooth.toFixed(2)}`;
}

  // State stabilization
  const now = millis();
  if (rawState !== lastState) {
    lastState = rawState;
    lastSwitchMs = now;
  }
  if (now - lastSwitchMs > HOLD_MS && stableState !== rawState) {
    stableState = rawState;
    onStateChanged(stableState);
  }

  // Audio shaping
  if (audioReady && sndLoaded) {
    updateStreamingShaping(stableState, opennessSmooth, energySmooth);
  }

  // Visual
  drawSoundViz(stableState, opennessSmooth, energySmooth);

  // Skeleton
  drawSkeletonPanel();
}

// ------------------------------------------------------------
// VIDEO + HANDS
// ------------------------------------------------------------
async function startCameraAndHands(w = 320, h = 240) {
  if (typeof Hands === "undefined") {
    throw new Error("MediaPipe Hands is not defined. Check hands.js include in HTML.");
  }

  videoP5 = createCapture(VIDEO);
  videoP5.size(w, h);
  videoP5.hide();

  await waitForVideoReady(videoP5, 8000);

  hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  hands.onResults(onHandsResults);
  mpReady = true;
}

function waitForVideoReady(v, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (v && v.elt && v.elt.readyState >= 2) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("Camera timeout (permission/HTTPS)."));
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function onHandsResults(results) {
  handsData = [];
  if (!results || !results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;

  for (let i = 0; i < results.multiHandLandmarks.length; i++) {
    const lm = results.multiHandLandmarks[i];
    const handed =
      results.multiHandedness && results.multiHandedness[i] ? results.multiHandedness[i].label : "Unknown";

    handsData.push({
      lmNorm: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      handedness: handed,
    });
  }
}

function getBestHand() {
  if (!handsData || handsData.length === 0) return null;
  return handsData[0];
}

// ------------------------------------------------------------
// GESTURE ESTIMATION
// ------------------------------------------------------------
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function estimateOpenness(lm) {
  const wrist = lm[0];
  const mcp = [lm[5], lm[9], lm[13], lm[17]];
  const tips = [lm[8], lm[12], lm[16], lm[20]];

  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const dTip = dist2(tips[i], wrist);
    const dMcp = dist2(mcp[i], wrist);
    const ratio = dMcp > 0.0001 ? dTip / dMcp : 1.0;
    const v = constrain((ratio - 1.25) / (2.10 - 1.25), 0, 1);
    acc += v;
  }
  acc /= 4;

  const thumbTip = lm[4];
  const indexMcp = lm[5];
  const dThumb = dist2(thumbTip, indexMcp);
  const thumbVal = constrain((dThumb - 0.06) / 0.14, 0, 1);

  return constrain(acc * 0.78 + thumbVal * 0.22, 0, 1);
}

function fingerCurl01(lm, mcpIdx, tipIdx) {
  const wrist = lm[0];
  const mcp = lm[mcpIdx];
  const tip = lm[tipIdx];

  const dTip = dist2(tip, wrist);
  const dMcp = dist2(mcp, wrist);
  const ratio = dMcp > 0.0001 ? dTip / dMcp : 1.0;

  // ratio high => finger extended, ratio low => curled
  return constrain((1.85 - ratio) / (1.85 - 1.25), 0, 1);
}

function estimateCurl(lm) {
  const curlIndex = fingerCurl01(lm, 5, 8);
  const curlMiddle = fingerCurl01(lm, 9, 12);
  const curlRing = fingerCurl01(lm, 13, 16);
  const curlPinky = fingerCurl01(lm, 17, 20);

  const raw = curlIndex * 0.30 + curlMiddle * 0.30 + curlRing * 0.20 + curlPinky * 0.20;
  const biased = lerp(raw, Math.max(curlIndex, curlMiddle) * 0.9, 0.22);
  return constrain(biased, 0, 1);
}

// Estensione dito 0..1 usando ratio tip/wrist vs mcp/wrist (1.0 circa chiuso, >2 esteso)
function fingerExtend01(lm, mcpIdx, tipIdx) {
  const wrist = lm[0];
  const mcp = lm[mcpIdx];
  const tip = lm[tipIdx];

  const dTip = dist2(tip, wrist);
  const dMcp = dist2(mcp, wrist);
  const ratio = dMcp > 0.0001 ? dTip / dMcp : 1.0;

  // Mappa più "precoce": già a ratio ~1.55 lo consideriamo abbastanza esteso
  return constrain((ratio - 1.30) / (1.90 - 1.30), 0, 1);
}

function classifyStateEarlySemi(lm, open01, curl01) {
  const idxExt = fingerExtend01(lm, 5, 8);
  const midExt = fingerExtend01(lm, 9, 12);
  const ringExt = fingerExtend01(lm, 13, 16);
  const pinkyExt = fingerExtend01(lm, 17, 20);

  const twoFingerExt = (idxExt + midExt) * 0.5;
  const othersExt = (ringExt + pinkyExt) * 0.5;
  const allExt = (idxExt + midExt + ringExt + pinkyExt) * 0.25;

  // Soglie principali
  const OPEN_TH = 0.54;

  // Closed: evita OR troppo aggressivo
  const FEAR_OPEN_MAX = 0.20;
  const FEAR_CURL_MIN = 0.74;
  const closedStrong = (open01 <= FEAR_OPEN_MAX && curl01 >= 0.55) || (curl01 >= FEAR_CURL_MIN);
  if (closedStrong) return "closed";

  // OPEN: più tollerante (qui stava il tuo collo di bottiglia)
  // Prima: curl01 <= 0.10 e allExt >= 0.72
  const openStrong =
    open01 >= OPEN_TH &&
    curl01 <= 0.18 &&
    allExt >= 0.62 &&
    othersExt >= 0.55;

  // Isteresi: se eri già open, resta open finché non scendi davvero
  const openHold =
    stableState === "open" &&
    open01 >= 0.48 &&
    curl01 <= 0.24;

  if (openStrong || openHold) return "open";

  // SEMI: non deve rubare casi quasi-open
  // Gate: se allExt è alto o open01 è molto alto, non permettere "semi"
  const SEMI_TWO_FINGER_MIN = 0.20;
  const SEMI_TWO_FINGER_MAX = 0.88;
  const SEMI_OTHERS_MAX = 0.65;

  const SEMI_OPEN_MAX = 0.72;     // più basso: se open01 è alto, probabilmente è open
  const SEMI_CURL_MAX = 0.75;
  const SEMI_CURL_MIN = 0.08;

  const semiEarly =
    twoFingerExt >= SEMI_TWO_FINGER_MIN &&
    twoFingerExt <= SEMI_TWO_FINGER_MAX &&
    othersExt <= SEMI_OTHERS_MAX &&
    open01 <= SEMI_OPEN_MAX &&
    curl01 <= SEMI_CURL_MAX &&
    curl01 >= SEMI_CURL_MIN &&
    allExt <= 0.66;               // gate fondamentale: se tutta la mano è estesa, non è "semi"

  if (semiEarly) return "semi";

  // Fallback coerente
  if (open01 >= OPEN_TH) return "open";
  return "semi";
}

// ------------------------------------------------------------
// AUDIO ENGINE
// ------------------------------------------------------------
function initStreamingEngine() {
  if (sndLoaded) return;

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  globalGain = audioCtx.createGain();
  globalGain.gain.value = 0.85;

  filterNode = audioCtx.createBiquadFilter();
  filterNode.type = "lowpass";
  filterNode.frequency.value = 1600;
  filterNode.Q.value = 1.0;

  filterNode.connect(globalGain);
  globalGain.connect(audioCtx.destination);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyserData = new Uint8Array(analyser.fftSize);
  filterNode.connect(analyser);

  mediaEls.open = createMediaElementExact("open", AUDIO_PATH.open);
  mediaEls.semi = createMediaElementExact("semi", AUDIO_PATH.semi);
  mediaEls.closed = createMediaElementExact("closed", AUDIO_PATH.closed);

  for (const k of ["open", "semi", "closed"]) {
    const el = mediaEls[k];
    if (!el) continue;

    const src = audioCtx.createMediaElementSource(el);
    mediaSources[k] = src;

    const g = audioCtx.createGain();
    g.gain.value = 0.0;
    mediaGains[k] = g;

    src.connect(g);
    g.connect(filterNode);

    el.loop = true;
    el.play().catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (!audioCtx || !globalGain) return;
    if (document.hidden) {
      visPausedDueToHidden = true;
      globalGain.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.02);
    } else {
      visPausedDueToHidden = false;
      globalGain.gain.setTargetAtTime(0.85, audioCtx.currentTime, 0.05);
    }
  });

  sndLoaded = true;
}

function createMediaElementExact(label, path) {
  const el = document.createElement("audio");
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.style.display = "none";
  el.src = path;

  el.addEventListener("error", () => {
    console.error("[audio]", label, "FAILED:", path);
  });

  document.body.appendChild(el);
  el.load();
  return el;
}

function fadeToSampleStreaming(targetKey, fadeSec = 0.25) {
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const fade = Math.max(0.02, fadeSec);

  for (const k of ["open", "semi", "closed"]) {
    const g = mediaGains[k];
    if (!g) continue;

    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);

    if (k === targetKey) {
      g.gain.linearRampToValueAtTime(0.9, now + fade);
      currentPlaying = k;
      const el = mediaEls[k];
      if (el && el.paused) el.play().catch(() => {});
    } else {
      g.gain.linearRampToValueAtTime(0.0, now + fade);
    }
  }

  if (!targetKey) currentPlaying = null;
}

function stopAllStreaming(fadeSec = 0.12) {
  fadeToSampleStreaming(null, fadeSec);
  currentPlaying = null;
}

function updateStreamingShaping(state, open01, energy01) {
  if (!audioCtx || !filterNode) return;

  const baseRate =
    state === "open" ? lerp(1.00, 1.03, energy01) :
    state === "semi" ? lerp(0.97, 1.01, energy01) :
    state === "closed" ? lerp(0.95, 1.02, energy01) :
    1.0;

  for (const k of ["open", "semi", "closed"]) {
    const el = mediaEls[k];
    if (!el) continue;
    el.playbackRate = Math.max(0.85, Math.min(1.12, baseRate));
  }

  const cutoff =
    state === "open" ? lerp(1800, 3200, open01) + energy01 * 200 :
    state === "semi" ? lerp(900, 1800, open01) + energy01 * 140 :
    state === "closed" ? lerp(520, 1200, open01) + energy01 * 100 :
    1200;

  filterNode.frequency.setTargetAtTime(constrain(cutoff, 120, 8000), audioCtx.currentTime, 0.05);
}

function onStateChanged(state) {
  if (!audioReady || !sndLoaded) return;

  if (state === "open") fadeToSampleStreaming("open", 0.25);
  else if (state === "semi") fadeToSampleStreaming("semi", 0.25);
  else if (state === "closed") fadeToSampleStreaming("closed", 0.25);
  else stopAllStreaming(0.25);
}

// ------------------------------------------------------------
// VISUAL
// ------------------------------------------------------------
function drawSoundViz(state, open01, energy01) {
  // nero fisso (come nelle reference)
  background(0);

  const a = getAudioLevel(); // 0..1 (ampiezza reale)
  const speed = (1.2 + a * 10.0); // reattività: più volume = più scorrimento
  scrollX = (scrollX + speed) % (width * 4);

  // “peso” grafico guidato dal suono
  const thick = lerp(10, 60, a);     // spessore bande
  const stepW = lerp(16, 72, a);     // quanto è “a gradini”
  const jitter = lerp(0.0, 0.9, a);  // micro instabilità

  if (state === "open") {
    // Allegro: fasce orizzontali larghe, pulite, su nero
    drawJoyBands(scrollX, thick, stepW, jitter);
  } else if (state === "semi") {
    // Tristezza: doppia pagina (sinistra chiara, destra scura) + rumore “testuale”
    drawSadSpread(scrollX, thick, stepW, jitter, a);
  } else if (state === "closed") {
    // Paura: bande più aggressive e “taglienti”, inclinate e spezzate
    drawFearStripes(scrollX, thick, stepW, jitter, a);
  } else {
    // idle: tenue
    drawJoyBands(scrollX, thick * 0.55, stepW * 0.75, jitter * 0.5);
  }
}

function drawJoyBands(sx, thick, stepW, jitter) {
  noStroke();
  fill(255);

  const a = getAudioLevel();
  const t = millis() * 0.001;

  const bands = 3;

  // Manteniamo le tue dimensioni
  const bandH = lerp(34, 90, a);
  const dx = lerp(60, 34, a);

  // Stessa struttura ma meno aggressiva
  const qY = 8;        // prima 12 → meno “scalino brusco”
  const qWave = 14;    // prima 16 → gradini leggermente più piccoli

  const baseY = [
    height * 0.25,
    height * 0.50,
    height * 0.75
  ];

  const ampBase = lerp(18, 70, a);

  const freqs = [0.010, 0.013, 0.016];
  const phases = [0.0, 1.7, 3.1];

  // 🔹 smoothing dell'onda per evitare micro scatti
  const smoothFactor = 0.85;

  for (let b = 0; b < bands; b++) {

    const amp = ampBase * (0.9 + b * 0.1);
    const steps = Math.ceil(width / dx) + 8;

    let prevWave = 0;

    for (let i = -4; i < steps; i++) {
      const x = i * dx - (sx % dx);

      const waveRaw =
        Math.sin((x + sx * 0.55) * freqs[b] + t * (1.4 + a * 2.6) + phases[b]) * amp;

      // quantizzazione mantenuta
      let wave = Math.round(waveRaw / qWave) * qWave;

      // 🔹 micro smoothing tra segmenti
      wave = prevWave * smoothFactor + wave * (1 - smoothFactor);
      prevWave = wave;

      // rumore ridotto (meno jitter nervoso)
      const n = noise(200 + b * 30 + i * 0.12, t * 0.4);
      const edgeJ = Math.round(((n - 0.5) * (8 + a * 16)) / 8) * 8;

      let y = baseY[b] + wave + edgeJ;
      y = Math.round(y / qY) * qY;

      let h = bandH * (0.85 + a * 0.35);
      h = Math.round(h / 8) * 8;

      rect(x, y, dx + 1, h);
    }
  }
}

function drawSadSpread(sx, thick, stepW, jitter, a) {
  background(0);

  const mid = width * 0.5;
  const gutter = 12;

  const bandH = lerp(12, 22, a);
  const gap = lerp(28, 40, a);

  const dx = 28;        // gradini
  const qY = 8;         // quantizzazione verticale
  const t = millis() * 0.0007;

  // Quanta frammentazione “globale” (più audio = più rottura)
  const fragAmount = constrain(0.50 + a * 0.55, 0.12, 0.75);

  // Helper: disegna una riga a gradini, con frammenti sparsi lungo tutta la riga
  const drawRow = (xL, xR, y, seedOffset, extraFrag) => {
    const span = xR - xL;
    const steps = Math.ceil(span / dx) + 6;

    for (let i = -3; i < steps; i++) {
      const x = xL + i * dx - (sx % dx);

      // offset verticale a gradini
      const n = noise(seedOffset + i * 0.22, y * 0.02, t);
      const offset = Math.round(((n - 0.5) * 14) / qY) * qY;

      // decisione frammentazione: noise 2D “stabile”
      const f = noise(900 + seedOffset * 2 + i * 0.35, y * 0.06, t * 0.6);

      // probabilità frammento: base + audio + (lato destro può spingere di più)
      const pFrag = constrain((fragAmount + extraFrag) * 0.85, 0, 0.95);

      // Se frammentato: non disegniamo il blocco pieno, ma pezzetti
      if (f < pFrag) {
        const pieces = 1 + Math.floor(lerp(1, 5, a) * (0.6 + extraFrag));

        for (let p = 0; p < pieces; p++) {
          const px = x + random(dx);
          const py = y + offset + random(bandH);

          // mix pixel e micro-segmenti orizzontali
          if (random() < 0.55) rect(px, py, 1, 1);
          else rect(px, py, random(3, 10), 1);
        }

        // a volte lasciamo comunque un frammento “solido” piccolo
        if (random() < 0.25) {
          rect(x + random(dx * 0.25), y + offset, dx * random(0.25, 0.6), bandH);
        }
      } else {
        // segmento pieno
        rect(x, y + offset, dx + 1, bandH);
      }
    }
  };

  noStroke();
  fill(255);

  for (let y = 40; y < height - 40; y += (bandH + gap)) {
    // sinistra: frammentazione leggera
    drawRow(0, mid - gutter, y, 10, 0.08);

    // destra: un po’ più rotta (come nel riferimento)
    drawRow(mid + gutter, width, y, 210, 0.22);
  }

  // Rumore tipografico “fondo” sulla destra (discreto, cresce con audio)
  const textNoiseCount = Math.floor(80 + a * 420);
  fill(255);
  noStroke();

  for (let i = 0; i < textNoiseCount; i++) {
    const x = random(mid + gutter + 10, width - 10);
    const y = random(10, height - 10);

    if (random() < 0.7) rect(x, y, 1, 1);
    else rect(x, y, 2, 1);
  }
}

function drawSteppedLine(xL, xR, y, h, sx, stepW, jitter) {
  const steps = Math.ceil((xR - xL) / stepW) + 6;

  for (let i = -3; i < steps; i++) {
    const x = xL + i * stepW - (sx % stepW);

    const n = noise(i * 0.18, y * 0.02, millis() * 0.0008);
    const dy = Math.round(((n - 0.5) * 10 * jitter) / 3) * 3;

    rect(x, y + dy, stepW + 1, h);
  }
}

function drawFearStripes(sx, thick, stepW, jitter, a) {
  push();

  // ruota leggermente per ottenere le diagonali
  translate(width * 0.5, height * 0.5);
  rotate(radians(-12));
  translate(-width * 0.5, -height * 0.5);

  // fondo scuro
  background(0);

  noStroke();
  fill(255);

  // più volume = più “taglio” e più velocità interna
  const localStep = lerp(10, 34, a);
  const bandH = lerp(16, 54, a);
  const gap = lerp(20, 70, a);

  // disegniamo fasce inclinate come “blocchi a gradini”
  for (let y = -height * 0.2; y < height * 1.2; y += (bandH + gap)) {
    const steps = Math.ceil(width / localStep) + 10;

    for (let i = -5; i < steps; i++) {
      const x = i * localStep - (sx % localStep);

      // bordo inferiore “seghettato”
      const n = noise(i * 0.25, y * 0.04, millis() * 0.0011);
      const cut = Math.round(((n - 0.5) * 18 * (0.5 + a)) / 2) * 2;

      rect(x, y + cut, localStep + 1, bandH);
    }
  }

  pop();
}

// ------------------------------------------------------------
// SKELETON PANEL
// ------------------------------------------------------------
function drawSkeletonPanel() {
  const holder = document.getElementById("camera-canvas-holder");
  if (!holder) return;

  const rectBox = holder.getBoundingClientRect();
  const pw = Math.max(10, Math.floor(rectBox.width));
  const ph = Math.max(10, Math.floor(rectBox.height));

  if (skelGfx.width !== pw || skelGfx.height !== ph) skelGfx.resizeCanvas(pw, ph);

  const detection = getBestHand();
  if (detection) {
    const conn = [
      [0, 1],[1, 2],[2, 3],[3, 4],
      [0, 5],[5, 6],[6, 7],[7, 8],
      [0, 9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5, 9],[9,13],[13,17],
    ];

    skelGfx.stroke(120);
    skelGfx.strokeWeight(2);

    for (const [a, b] of conn) {
      const pa = detection.lmNorm[a];
      const pb = detection.lmNorm[b];
      const xa = (1 - pa.x) * pw;
      const ya = pa.y * ph;
      const xb = (1 - pb.x) * pw;
      const yb = pb.y * ph;
      skelGfx.line(xa, ya, xb, yb);
    }

    skelGfx.noStroke();
    skelGfx.fill(17);
    for (const p of detection.lmNorm) {
      const x = (1 - p.x) * pw;
      const y = p.y * ph;
      skelGfx.circle(x, y, 5);
    }
  }

  ensureSkeletonDOMCanvas(pw, ph);
}

function ensureSkeletonDOMCanvas(w, h) {
  if (!skelDomCanvas) {
    skelDomCanvas = document.createElement("canvas");
    skelDomCanvas.style.width = "100%";
    skelDomCanvas.style.height = "100%";
    skelDomCanvas.style.display = "block";
    skelDomCanvas.width = w;
    skelDomCanvas.height = h;
    skelDomCtx = skelDomCanvas.getContext("2d");

    const holder = document.getElementById("camera-canvas-holder");
    if (holder) {
      holder.innerHTML = "";
      holder.appendChild(skelDomCanvas);
    }
  }

  if (skelDomCanvas.width !== w || skelDomCanvas.height !== h) {
    skelDomCanvas.width = w;
    skelDomCanvas.height = h;
  }

  if (skelDomCtx && skelGfx && skelGfx.elt) {
    skelDomCtx.clearRect(0, 0, w, h);
    skelDomCtx.drawImage(skelGfx.elt, 0, 0, w, h);
  }
}

// ------------------------------------------------------------
// RESIZE
// ------------------------------------------------------------
function resizeAll() {
  const holder = document.getElementById("sound-canvas-holder");
  if (!holder) return;

  const r = holder.getBoundingClientRect();
  const w = Math.max(10, Math.floor(r.width));
  const h = Math.max(10, Math.floor(r.height));
  resizeCanvas(w, h);

  positionInfoCard();
}

function positionInfoCard() {
  if (!infoCard) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const cardW = Math.min(640, Math.floor(vw * 0.72));
  const cardH = Math.min(Math.floor(vh * 0.64), 520);

  infoCard.style.width = cardW + "px";
  infoCard.style.maxHeight = cardH + "px";

  const leftCol = 360;
  const x = Math.max(18, leftCol + 24);
  const y = Math.max(18, Math.floor(vh * 0.16));

  infoCard.style.left = x + "px";
  infoCard.style.top = y + "px";
}

// ------------------------------------------------------------
// INFO LAYER
// ------------------------------------------------------------
function wireInfoLayer() {
  if (!infoLayer || !openInfoBtn || !closeInfoBtn || !infoBackdrop) return;

  const open = () => {
    infoLayer.classList.add("is-open");
    infoLayer.setAttribute("aria-hidden", "false");
    positionInfoCard();
  };

  const close = () => {
    infoLayer.classList.remove("is-open");
    infoLayer.setAttribute("aria-hidden", "true");
  };

  openInfoBtn.addEventListener("click", open);
  closeInfoBtn.addEventListener("click", close);
  infoBackdrop.addEventListener("click", close);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

function getAudioLevel() {
  if (!analyser) return 0;

  analyser.getByteTimeDomainData(analyserData);

  let sum = 0;
  for (let i = 0; i < analyserData.length; i++) {
    const v = (analyserData[i] - 128) / 128; // -1 .. 1
    sum += v * v;
  }

  const rms = Math.sqrt(sum / analyserData.length); // 0..1 circa
  audioLevelSmooth = lerp(audioLevelSmooth, rms, 0.15);

  return constrain(audioLevelSmooth * 3.0, 0, 1);
}