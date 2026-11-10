"""
config.py
---------
Centralized application configuration.

All environment-dependent values (paths, limits, model settings) live here so
that the rest of the codebase never hard-codes them. Values can be overridden
via environment variables, which makes the app friendly to Docker / cloud
deployment without code changes.
"""

import os
from pathlib import Path


class Config:
    """Base configuration shared by all environments."""

    # --- Core Flask settings -------------------------------------------------
    SECRET_KEY = os.environ.get("SECRET_KEY", "change-this-in-production")
    DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"

    # --- Paths -----------------------------------------------------------------
    BASE_DIR = Path(__file__).resolve().parent
    UPLOAD_FOLDER = BASE_DIR / "static" / "uploads"
    RESULT_FOLDER = BASE_DIR / "static" / "results"
    LOG_FOLDER = BASE_DIR / "logs"
    MODEL_CACHE_DIR = BASE_DIR / "model_cache"

    # --- Upload constraints ------------------------------------------------
    ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
    MAX_CONTENT_LENGTH = int(os.environ.get("MAX_UPLOAD_MB", 15)) * 1024 * 1024  # 15 MB default
    MAX_IMAGE_DIMENSION = int(os.environ.get("MAX_IMAGE_DIMENSION", 2048))  # px, longest side

    # --- Inpainting model settings ------------------------------------------
    # "lama"  -> fast CNN based inpainting (recommended, low VRAM, great for object removal)
    # "sdxl"  -> Stable Diffusion XL Inpainting (higher quality/slower, needs more VRAM)
    INPAINT_BACKEND = os.environ.get("INPAINT_BACKEND", "lama")
    SDXL_MODEL_ID = os.environ.get(
        "SDXL_MODEL_ID", "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
    )
    SDXL_STEPS = int(os.environ.get("SDXL_STEPS", 30))
    SDXL_GUIDANCE_SCALE = float(os.environ.get("SDXL_GUIDANCE_SCALE", 7.5))

    # Device selection: "auto" picks CUDA if available, else CPU.
    DEVICE = os.environ.get("DEVICE", "auto")

    # Mask dilation (in px) applied before inpainting to better cover object edges/shadows.
    MASK_DILATE_PX = int(os.environ.get("MASK_DILATE_PX", 6))

    # --- Housekeeping --------------------------------------------------------
    FILE_RETENTION_MINUTES = int(os.environ.get("FILE_RETENTION_MINUTES", 60))

    @staticmethod
    def init_app(app):
        """Ensure required directories exist at startup."""
        for folder in (
            Config.UPLOAD_FOLDER,
            Config.RESULT_FOLDER,
            Config.LOG_FOLDER,
            Config.MODEL_CACHE_DIR,
        ):
            Path(folder).mkdir(parents=True, exist_ok=True)


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


config_map = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig,
}
