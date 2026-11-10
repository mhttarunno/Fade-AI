"""
services/enhancement_service.py
-------------------------------
AI Image Enhancement.
Provides:
  - 2x and 4x Super-Resolution Upscaling (Lanczos with edge sharpening)
  - Edge-preserving bilateral noise reduction
  - Adaptive unsharp mask sharpening
  - CLAHE contrast and vibrancy enhancement
"""

from pathlib import Path
from typing import Tuple

import cv2
import numpy as np
from PIL import Image

from services.image_service import load_image, save_image
from utils.file_utils import generate_unique_filename
from utils.logger import get_logger

logger = get_logger(__name__)


def enhance_image(
    source_image_path: Path,
    result_folder: Path,
    scale: int = 2,
    denoise: bool = True,
    sharpen: bool = True,
    enhance_contrast: bool = True,
) -> Tuple[Path, str]:
    """
    Applies image enhancement algorithms to improve quality, sharpness, and resolution.

    Args:
        source_image_path: Input image file path
        result_folder: Output directory
        scale: 1, 2, or 4 (upscale multiplier)
        denoise: Whether to apply bilateral denoising
        sharpen: Whether to apply unsharp masking
        enhance_contrast: Whether to apply adaptive contrast enhancement

    Returns:
        (result_path, result_filename)
    """
    logger.info("Enhancing image %s (scale=%dx, denoise=%s, sharpen=%s)", source_image_path, scale, denoise, sharpen)
    img_pil = load_image(source_image_path).convert("RGB")
    width, height = img_pil.size

    # 1. Upscale if requested
    scale = max(1, min(scale, 4))
    if scale > 1:
        new_w = width * scale
        new_h = height * scale
        img_pil = img_pil.resize((new_w, new_h), Image.Resampling.LANCZOS)

    img_np = np.array(img_pil)  # RGB
    # Convert to BGR for OpenCV
    bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)

    # 2. Denoising: Bilateral filter smooths textures while keeping edges sharp
    if denoise:
        bgr = cv2.bilateralFilter(bgr, d=7, sigmaColor=50, sigmaSpace=50)

    # 3. Contrast enhancement via CLAHE in LAB color space
    if enhance_contrast:
        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l = clahe.apply(l)
        enhanced_lab = cv2.merge((l, a, b))
        bgr = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)

    # 4. Sharpening: Unsharp mask
    if sharpen:
        gaussian = cv2.GaussianBlur(bgr, (0, 0), sigmaX=2.0)
        unsharp = cv2.addWeighted(bgr, 1.4, gaussian, -0.4, 0)
        bgr = np.clip(unsharp, 0, 255).astype(np.uint8)

    # Convert back to RGB PIL
    rgb_result = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    result_img = Image.fromarray(rgb_result)

    result_filename = generate_unique_filename(f"enhanced_{scale}x_{source_image_path.name}")
    result_path = result_folder / result_filename
    save_image(result_img, result_path)

    logger.info("Image enhancement complete: %s", result_path)
    return result_path, result_filename

