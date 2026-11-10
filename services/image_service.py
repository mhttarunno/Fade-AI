"""
services/image_service.py
--------------------------
Pure image-processing helpers built on Pillow/OpenCV/NumPy: loading images
safely, normalizing orientation, resizing to a safe processing resolution,
preparing/dilating masks, and encoding results back to bytes.

Keeping this logic separate from Flask routes and from the model wrappers
makes each piece independently testable and keeps services/inpainting_service.py
focused purely on orchestration.
"""

import io
from pathlib import Path
from typing import Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps

from utils.logger import get_logger

logger = get_logger(__name__)


def load_image(path: Path) -> Image.Image:
    """
    Load an image from disk, auto-correct EXIF orientation (common with
    photos taken on phones), and convert to RGB.
    """
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)  # respect camera rotation metadata
    return image.convert("RGB")


def resize_to_max_dimension(image: Image.Image, max_dimension: int) -> Tuple[Image.Image, float]:
    """
    Downscale `image` in-place proportionally so its longest side does not
    exceed `max_dimension`. Large images are both slow to run through the
    model and a potential memory-exhaustion vector, so we cap them.

    Returns (resized_image, scale_factor) where scale_factor = new / original,
    so the caller can map coordinates/masks back if needed.
    """
    width, height = image.size
    longest_side = max(width, height)

    if longest_side <= max_dimension:
        return image, 1.0

    scale_factor = max_dimension / longest_side
    new_size = (int(width * scale_factor), int(height * scale_factor))
    resized = image.resize(new_size, Image.LANCZOS)
    logger.info("Resized image from %s to %s (scale=%.4f)", image.size, new_size, scale_factor)
    return resized, scale_factor


def prepare_mask(mask_bytes: bytes, target_size: Tuple[int, int], dilate_px: int = 6) -> Image.Image:
    """
    Convert raw mask bytes (drawn by the user on an HTML canvas, where the
    painted/brushed area is opaque) into a clean binary mask matching the
    target image size, ready for the inpainting model.

    Steps:
      1. Decode to grayscale.
      2. Resize (nearest-neighbor to keep hard edges) to match the image.
      3. Threshold to pure black/white (handles anti-aliased brush strokes).
      4. Dilate slightly so mask fully covers object edges/shadows/halos,
         which produces noticeably cleaner inpainting results.
    """
    mask_image = Image.open(io.BytesIO(mask_bytes)).convert("L")

    if mask_image.size != target_size:
        mask_image = mask_image.resize(target_size, Image.NEAREST)

    mask_np = np.array(mask_image)

    # Binarize: any pixel with reasonable opacity/brightness is "selected".
    _, binary_mask = cv2.threshold(mask_np, 30, 255, cv2.THRESH_BINARY)

    if dilate_px > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px, dilate_px))
        binary_mask = cv2.dilate(binary_mask, kernel, iterations=1)

    return Image.fromarray(binary_mask, mode="L")


def mask_has_content(mask: Image.Image, min_pixels: int = 20) -> bool:
    """Check that the mask actually selects a non-trivial region."""
    mask_np = np.array(mask)
    selected_pixels = int(np.count_nonzero(mask_np))
    return selected_pixels >= min_pixels


def image_to_bytes(image: Image.Image, fmt: str = "PNG") -> bytes:
    """Encode a PIL image to bytes in-memory (no disk round-trip)."""
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def save_image(image: Image.Image, path: Path, fmt: str = "PNG") -> Path:
    """Persist a PIL image to disk, creating parent directories if needed."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format=fmt)
    logger.info("Saved image to %s", path)
    return path


def create_side_by_side_preview(before: Image.Image, after: Image.Image) -> Image.Image:
    """Utility for building a simple before/after debug preview (optional)."""
    height = max(before.height, after.height)
    total_width = before.width + after.width
    canvas = Image.new("RGB", (total_width, height), (255, 255, 255))
    canvas.paste(before, (0, 0))
    canvas.paste(after, (before.width, 0))
    return canvas
