// PDF Voice Reader: extracts text with pdf.js and reads it aloud with Kokoro (in-browser AI TTS)
// or the browser's built-in speech synthesis.

const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// English voices only. Softer, higher-pitched ones first: they suit the "anime narrator" feel best.
const VOICES = [
  ["af_heart", "Heart (bright, warm)"],
  ["af_bella", "Bella (energetic)"],
  ["af_nicole", "Nicole (soft, calm)"],
  ["af_sky", "Sky (light)"],
  ["af_nova", "Nova"],
  ["af_sarah", "Sarah"],
  ["af_kore", "Kore"],
  ["af_aoede", "Aoede"],
  ["af_alloy", "Alloy"],
  ["af_jessica", "Jessica"],
  ["af_river", "River"],
  ["bf_emma", "Emma (British)"],
  ["bf_isabella", "Isabella (British)"],
  ["bf_alice", "Alice (British)"],
  ["bf_lily", "Lily (British)"],
  ["am_puck", "Puck (male)"],
  ["am_michael", "Michael (male)"],
  ["am_fenrir", "Fenrir (male)"],
  ["bm_george", "George (British male)"],
  ["bm_fable", "Fable (British male)"],
];

const $ = (id) => document.getElementById(id);
const el = {
  drop: $("dropzone"), file: $("file"), pick: $("pick"), status: $("status"),
  controls: $("controls"), reader: $("reader"), play: $("play"), prev: $("prev"),
  next: $("next"), stop: $("stop"), engine: $("engine"), voice: $("voice"),
  voiceWrap: $("voiceWrap"), speed: $("speed"), speedOut: $("speedOut"),
  page: $("page"), load: $("load"),
};

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ---------------------------------------------------------------- settings

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

for (const [id, name] of VOICES) el.voice.add(new Option(name, id));
el.voice.value = store.get("voice", "af_heart");
if (!el.voice.value) el.voice.value = "af_heart";
el.engine.value = store.get("engine", "kokoro");
el.speed.value = store.get("speed", "1");
const updateSpeedLabel = () => { el.speedOut.textContent = `${Number(el.speed.value).toFixed(1)}×`; };
updateSpeedLabel();

// ---------------------------------------------------------------- state

let chunks = [];          // { text, page, span }
let pageStart = [];       // index of first chunk of each page
let index = 0;            // current chunk
let state = "idle";       // idle | playing | paused
let token = 0;            // bumped to cancel any in-flight playback
const audioCache = new Map(); // chunk index -> Promise<AudioBuffer>
let audioCtx = null;
let currentSource = null;

// ---------------------------------------------------------------- PDF loading

function setStatus(msg) { el.status.textContent = msg; }

async function openPdf(file) {
  stop();
  setStatus(`Reading "${file.name}"…`);
  el.reader.replaceChildren();
  chunks = []; pageStart = []; audioCache.clear();
  try {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let totalChars = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const paragraphs = pageToParagraphs(content);
      pageStart.push(chunks.length);
      const head = document.createElement("div");
      head.className = "pageHead";
      head.textContent = `Page ${p}`;
      el.reader.append(head);
      for (const para of paragraphs) {
        const pEl = document.createElement("p");
        for (const sentence of mergeShort(splitSentences(para))) {
          const span = document.createElement("span");
          span.className = "s";
          span.textContent = sentence + " ";
          const i = chunks.length;
          span.addEventListener("click", () => jump(i));
          pEl.append(span);
          chunks.push({ text: sentence, page: p, span });
          totalChars += sentence.length;
        }
        el.reader.append(pEl);
      }
      setStatus(`Reading "${file.name}"… page ${p}/${pdf.numPages}`);
    }
    if (totalChars < 20) {
      setStatus("This PDF has no selectable text (it may be scanned images). Try a PDF with real text.");
      el.controls.hidden = true;
      return;
    }
    el.page.replaceChildren(...pageStart.map((_, i) => new Option(`${i + 1}`, String(i))));
    el.controls.hidden = false;
    index = 0;
    markNow();
    setStatus(`${file.name}: ${pdf.numPages} page(s), ${chunks.length} sentences. Press Play.`);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open that PDF: ${err.message || err}`);
  }
}

/** Turn pdf.js text items into paragraphs, using line breaks and vertical gaps. */
function pageToParagraphs(content) {
  const paras = [];
  let cur = "";
  let lastY = null;
  let lastH = 12;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const y = item.transform[5];
    const h = item.height || lastH;
    if (lastY !== null && Math.abs(y - lastY) > 0.5 * h) {
      const gap = Math.abs(y - lastY);
      if (gap > 1.8 * h) { // big gap = new paragraph
        if (cur.trim()) paras.push(cur);
        cur = "";
      } else if (cur && !cur.endsWith(" ")) {
        cur += cur.endsWith("-") ? "" : " "; // soft line wrap (join hyphenated words)
      }
    }
    cur += item.str;
    if (item.hasEOL && !cur.endsWith(" ")) cur += cur.endsWith("-") ? "" : " ";
    if (item.str.trim()) { lastY = y; lastH = h; }
  }
  if (cur.trim()) paras.push(cur);
  return paras.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function splitSentences(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)]
      .map((s) => s.segment.trim()).filter(Boolean);
  }
  return text.match(/[^.!?]+[.!?]*["')\]]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

/** Very short sentences sound choppy on their own, so glue them to the next one. */
function mergeShort(sentences) {
  const out = [];
  let buf = "";
  for (const s of sentences) {
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= 40) { out.push(buf); buf = ""; }
  }
  if (buf) {
    if (out.length && buf.length < 40) out[out.length - 1] += ` ${buf}`; else out.push(buf);
  }
  // Keep chunks a manageable size for the TTS model.
  return out.flatMap((s) => (s.length > 400 ? s.match(/.{1,400}(\s|$)/g).map((x) => x.trim()) : [s]));
}

// ---------------------------------------------------------------- Kokoro

let ttsPromise = null;

function loadKokoro() {
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async () => {
    el.load.hidden = false;
    el.load.removeAttribute("value"); // indeterminate until we get progress
    const files = new Map();
    const progress = (p) => {
      if (p.status === "progress" && p.file && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let l = 0, t = 0;
        for (const [a, b] of files.values()) { l += a; t += b; }
        el.load.max = t; el.load.value = l;
        setStatus(`Downloading voice model… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB (only the first time)`);
      }
    };
    const { KokoroTTS } = await import(KOKORO_URL);
    let tts;
    if (navigator.gpu) {
      try {
        tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "fp32", device: "webgpu", progress_callback: progress });
      } catch (e) { console.warn("WebGPU failed, using WASM", e); }
    }
    tts ??= await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm", progress_callback: progress });
    el.load.hidden = true;
    return tts;
  })().catch((e) => {
    ttsPromise = null;
    el.load.hidden = true;
    throw e;
  });
  return ttsPromise;
}

function getAudioBuffer(i) {
  if (audioCache.has(i)) return audioCache.get(i);
  const voice = el.voice.value;
  const speed = Number(el.speed.value);
  const p = (async () => {
    const tts = await loadKokoro();
    const out = await tts.generate(chunks[i].text, { voice, speed });
    const buf = audioCtx.createBuffer(1, out.audio.length, out.sampling_rate);
    buf.copyToChannel(out.audio, 0);
    return buf;
  })();
  audioCache.set(i, p);
  p.catch(() => audioCache.delete(i));
  // Don't hold the whole document in memory.
  for (const k of audioCache.keys()) if (k < i - 2) audioCache.delete(k);
  return p;
}

// ---------------------------------------------------------------- playback

function markNow() {
  document.querySelector(".s.now")?.classList.remove("now");
  const c = chunks[index];
  if (!c) return;
  c.span.classList.add("now");
  c.span.scrollIntoView({ block: "center", behavior: "smooth" });
  el.page.value = String(c.page - 1);
}

function setPlayLabel() {
  el.play.textContent = state === "playing" ? "⏸ Pause" : state === "paused" ? "▶ Resume" : "▶ Play";
}

async function speakLoop(myToken) {
  while (index < chunks.length && myToken === token) {
    markNow();
    try {
      if (el.engine.value === "kokoro") {
        audioCtx ??= new AudioContext();
        if (audioCtx.state === "suspended" && state === "playing") await audioCtx.resume();
        const i = index;
        const buf = await getAudioBuffer(i);
        if (myToken !== token) return;
        if (i + 1 < chunks.length) getAudioBuffer(i + 1).catch(() => {}); // prefetch next while this one plays
        setStatus(`Page ${chunks[i].page} · sentence ${i + 1}/${chunks.length}`);
        await new Promise((resolve) => {
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(audioCtx.destination);
          src.onended = resolve;
          currentSource = src;
          src.start();
        });
      } else {
        setStatus(`Page ${chunks[index].page} · sentence ${index + 1}/${chunks.length}`);
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(chunks[index].text);
          u.rate = Number(el.speed.value);
          u.lang = "en-US";
          u.onend = u.onerror = resolve;
          speechSynthesis.speak(u);
        });
      }
    } catch (err) {
      console.error(err);
      setStatus(`Voice error: ${err.message || err}. Try the built-in browser voice instead.`);
      state = "idle"; setPlayLabel();
      return;
    }
    if (myToken !== token) return;
    index++;
  }
  if (myToken === token) {
    state = "idle"; index = 0; setPlayLabel(); markNow();
    setStatus("Finished. Press Play to start again.");
  }
}

function cancelAudio() {
  token++;
  try { currentSource?.stop(); } catch { /* already stopped */ }
  currentSource = null;
  speechSynthesis.cancel();
}

async function play() {
  if (!chunks.length) return;
  if (state === "paused") {
    state = "playing"; setPlayLabel();
    if (el.engine.value === "kokoro") await audioCtx.resume(); else speechSynthesis.resume();
    return;
  }
  cancelAudio();
  state = "playing"; setPlayLabel();
  audioCtx ??= new AudioContext(); // must be created in a user gesture
  speakLoop(token);
}

async function pause() {
  state = "paused"; setPlayLabel();
  if (el.engine.value === "kokoro") await audioCtx?.suspend(); else speechSynthesis.pause();
}

function stop() {
  cancelAudio();
  state = "idle"; setPlayLabel();
  audioCtx?.resume?.();
}

function jump(i) {
  index = Math.max(0, Math.min(chunks.length - 1, i));
  const wasActive = state !== "idle";
  cancelAudio();
  state = "idle";
  markNow();
  if (wasActive) play(); else setPlayLabel();
}

// ---------------------------------------------------------------- UI wiring

el.pick.addEventListener("click", () => el.file.click());
el.drop.addEventListener("keydown", (e) => { if (e.key === "Enter") el.file.click(); });
el.file.addEventListener("change", () => el.file.files[0] && openPdf(el.file.files[0]));
for (const ev of ["dragenter", "dragover"]) el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("over"); });
el.drop.addEventListener("drop", (e) => {
  const f = [...e.dataTransfer.files].find((x) => x.type === "application/pdf" || x.name.toLowerCase().endsWith(".pdf"));
  if (f) openPdf(f); else setStatus("That doesn't look like a PDF.");
});

el.play.addEventListener("click", () => (state === "playing" ? pause() : play()));
el.stop.addEventListener("click", stop);
el.prev.addEventListener("click", () => jump(index - 1));
el.next.addEventListener("click", () => jump(index + 1));
el.page.addEventListener("change", () => jump(pageStart[Number(el.page.value)] ?? 0));

function settingsChanged() {
  audioCache.clear();
  if (state !== "idle") jump(index);
}
el.voice.addEventListener("change", () => { store.set("voice", el.voice.value); settingsChanged(); });
el.speed.addEventListener("input", updateSpeedLabel);
el.speed.addEventListener("change", () => { store.set("speed", el.speed.value); settingsChanged(); });
el.engine.addEventListener("change", () => {
  store.set("engine", el.engine.value);
  el.voiceWrap.hidden = el.engine.value !== "kokoro";
  settingsChanged();
});
el.voiceWrap.hidden = el.engine.value !== "kokoro";

document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.target.tagName) || !chunks.length) return;
  if (e.code === "Space") { e.preventDefault(); state === "playing" ? pause() : play(); }
  else if (e.code === "ArrowRight") jump(index + 1);
  else if (e.code === "ArrowLeft") jump(index - 1);
});
