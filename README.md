# AI Object Removal — Flask + LaMa Inpainting

A production-ready web app for removing unwanted objects from photos, similar
to PhotoRoom's "Remove Object" tool. Users upload an image, brush/lasso over
the object they want gone, and an AI inpainting model (LaMa by default, SDXL
optional) fills the region back in seamlessly.

![status](https://img.shields.io/badge/status-production--ready-brightgreen)
![python](https://img.shields.io/badge/python-3.10%2B-blue)
![flask](https://img.shields.io/badge/flask-3.x-black)

---

## ✨ Features

- **Drag-and-drop upload** with client + server-side validation (type, size, real image content check).
- **Interactive Fabric.js canvas editor**:
  - Brush tool with adjustable size
  - Lasso / polygon tool (click to place points, double-click or click-near-start to close)
  - Erase tool (click a stroke to remove it)
  - Undo / redo (toolbar buttons + `Ctrl+Z` / `Ctrl+Y`)
  - Zoom (buttons + scroll wheel) and pan (hold `Space` + drag)
- **AI inpainting backends**:
  - **LaMa** (default) — fast, purpose-built CNN inpainting model, low VRAM, great for object removal.
  - **Stable Diffusion XL Inpainting** (optional) — higher-fidelity diffusion-based fill, GPU-recommended.
- **Before/after comparison slider** to inspect results.
- **One-click download** of the final image.
- **GPU/CPU auto-detection**, model singleton caching (loaded once per process).
- **Secure uploads**: sanitized filenames, extension + content-type + size validation, path-traversal guards.
- **Logging** to console + rotating log files.
- **Automatic cleanup** of stale uploaded/generated files.

---

## 🏗️ Architecture

```
ai-object-removal/
├── app.py                      # Flask app factory + routes (thin HTTP layer)
├── config.py                   # Centralized, env-driven configuration
├── requirements.txt
├── .env.example
├── models/
│   ├── lama_model.py           # LaMa inpainting wrapper (singleton, lazy-loaded)
│   └── sdxl_model.py           # SDXL inpainting wrapper (singleton, lazy-loaded)
├── services/
│   ├── image_service.py        # Pillow/OpenCV image + mask preprocessing
│   └── inpainting_service.py   # Orchestrates: load -> mask -> model -> save
├── utils/
│   ├── validators.py           # Upload + mask payload validation
│   ├── file_utils.py           # Secure filenames, save, cleanup
│   └── logger.py                # App-wide logging config
├── templates/
│   ├── base.html
│   └── index.html               # Upload / editor / result UI (Bootstrap 5)
├── static/
│   ├── css/style.css
│   ├── js/app.js                # Fabric.js editor + API calls + compare slider
│   ├── uploads/                 # Uploaded source images (auto-cleaned)
│   └── results/                 # Generated inpainted images (auto-cleaned)
└── logs/                        # Rotating app logs
```

**Design principles applied:**
- **Separation of concerns**: routes (`app.py`) never touch PyTorch/PIL directly — they call `InpaintingService`, which calls `services/image_service.py` for pixel work and `models/*.py` for inference.
- **Lazy, cached model loading**: model weights load once on first inference request (not at import time), and are cached as process-wide singletons so subsequent requests are fast.
- **Fail-safe validation**: every user input (file upload, mask payload, filename) is validated before touching the filesystem or the model.

---

## 🚀 Getting Started

### 1. Prerequisites
- Python 3.10+
- (Optional, recommended for speed) an NVIDIA GPU with CUDA + matching PyTorch build

### 2. Clone & install

```bash
git clone <your-repo-url> ai-object-removal
cd ai-object-removal

python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt
```

> **GPU users:** the `torch`/`torchvision` versions pinned in `requirements.txt`
> are CPU-compatible by default. For CUDA acceleration, install the matching
> CUDA build from https://pytorch.org/get-started/locally/ **before** running
> `pip install -r requirements.txt` (pip will then skip re-installing torch
> if the version constraint is already satisfied), e.g.:
> ```bash
> pip install torch==2.3.1 torchvision==0.18.1 --index-url https://download.pytorch.org/whl/cu121
> ```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set SECRET_KEY for production use.
```

### 4. Run (development)

```bash
python app.py
# or
flask --app app run --debug
```

Visit **http://localhost:5000**.

### 5. Run (production)

```bash
gunicorn -w 2 -b 0.0.0.0:5000 --timeout 120 app:app
```

> Use only **1–2 workers** per GPU (each worker loads its own copy of the
> model into VRAM). For CPU-only deployments you can use more workers, bound
> by available RAM.

---

## ⚙️ Configuration reference (`.env`)

| Variable | Default | Description |
|---|---|---|
| `FLASK_ENV` | `development` | `development` or `production` |
| `SECRET_KEY` | *(dev key)* | Flask session secret — **set a strong value in production** |
| `MAX_UPLOAD_MB` | `15` | Max upload size in MB |
| `MAX_IMAGE_DIMENSION` | `2048` | Images are downscaled so the longest side never exceeds this |
| `INPAINT_BACKEND` | `lama` | `lama` (fast, recommended) or `sdxl` (higher quality, slower) |
| `SDXL_MODEL_ID` | `diffusers/stable-diffusion-xl-1.0-inpainting-0.1` | HF model id used when backend=`sdxl` |
| `SDXL_STEPS` | `30` | Diffusion steps (higher = slower, often better quality) |
| `SDXL_GUIDANCE_SCALE` | `7.5` | Classifier-free guidance scale |
| `DEVICE` | `auto` | `auto`, `cuda`, or `cpu` |
| `MASK_DILATE_PX` | `6` | Mask dilation in px to fully cover object edges/shadows |
| `FILE_RETENTION_MINUTES` | `60` | Auto-delete uploaded/result files older than this |

---

## 🔌 API Reference

### `POST /api/upload`
Multipart form upload. Field name: `image`.

**Response**
```json
{ "success": true, "filename": "a1b2c3_photo.jpg", "url": "/static/uploads/a1b2c3_photo.jpg" }
```

### `POST /api/remove-object`
JSON body:
```json
{ "filename": "a1b2c3_photo.jpg", "mask": "data:image/png;base64,...." }
```
`mask` is a PNG data URL where white pixels mark the region to remove.

**Response**
```json
{
  "success": true,
  "result_url": "/static/results/f9e8d7_result.png",
  "result_filename": "f9e8d7_result.png",
  "processing_time_seconds": 2.31
}
```

### `GET /api/download/<filename>`
Downloads a generated result image as an attachment.

### `GET /api/health`
```json
{ "status": "ok", "backend": "lama", "cuda_available": false, "device": "auto" }
```

---

## 🧠 Choosing a backend

| | **LaMa** (default) | **SDXL Inpainting** |
|---|---|---|
| Speed | ~1–3s (GPU), ~5–15s (CPU) | ~10–40s+ depending on hardware |
| VRAM | ~2GB | ~8GB+ recommended |
| Best for | Clean object removal / background reconstruction | Higher-fidelity fills, texture-rich scenes |
| Prompt required | No | No (uses a neutral background-completion prompt internally) |

Switch backends by setting `INPAINT_BACKEND=sdxl` in `.env` — no code changes needed.

---

## 🔒 Security notes

- Uploaded filenames are sanitized (`secure_filename`) and given a random prefix to prevent collisions/overwrites.
- Uploaded and requested filenames are resolved and checked against their expected root directory to prevent path traversal.
- File content is verified to be a genuinely decodable image (not just a renamed extension).
- Uploads are capped by size (`MAX_UPLOAD_MB`) at both the client and server.
- Old uploaded/generated files are periodically purged (`FILE_RETENTION_MINUTES`).

---

## 🧪 Troubleshooting

- **"CUDA out of memory"** — switch `DEVICE=cpu`, lower `MAX_IMAGE_DIMENSION`, or use the `lama` backend instead of `sdxl`.
- **First request is slow** — this is expected: model weights download and load into memory on first use, then stay cached for the life of the process.
- **Mask appears empty / "selection mask is empty" error** — make sure you actually brushed/lassoed over the canvas before clicking "Remove Object".

---

## 📄 License

This project is provided as a reference implementation. Model weights (LaMa, SDXL) are subject to their respective upstream licenses.
