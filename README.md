# PDF Voice Reader

Open a PDF and have it read aloud in an anime-style English voice. Everything runs in your browser; the PDF never leaves your device.

- **Voices:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) via `kokoro-js`, with 20 English voices. The model (~90 MB) downloads once and is cached by the browser. Uses WebGPU when available, otherwise WASM.
- **Fallback:** a built-in browser voice that starts instantly.
- **Reading:** the current sentence is highlighted, click any sentence to jump there, pick a start page, change speed.
- **Keys:** Space = play/pause, ← / → = previous/next sentence.

Note: there is no true "anime voicebank" for English that can run in a browser (VOICEVOX is Japanese-only; UTAU/VOCALOID banks are for singing). Kokoro's bright, expressive young-sounding voices (Heart, Bella, Nicole, Sky) are the closest fit.

Scanned PDFs (images with no selectable text) can't be read; OCR is not included.

## Run locally
ES modules need a web server (not `file://`):

```
python3 -m http.server 8000
```
then open http://localhost:8000.

## Host on GitHub Pages
Settings → Pages → Source: **GitHub Actions**. The included workflow deploys on every push to `main`.
