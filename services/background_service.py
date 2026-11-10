"""
services/background_service.py
------------------------------
AI Background Removal using rembg / ONNX Runtime.
Produces transparent PNG images preserving fine hair, edges, and object boundaries.
"""

from pathlib import Path
from typing import Tuple

from PIL import Image
import rembg

from services.image_service import load_image, resize_to_max_dimension
from utils.file_utils import generate_unique_filename
from utils.logger import get_logger

logger = get_logger(__name__)


def remove_background(
    source_image_path: Path,
    result_folder: Path,
    max_dimension: int = 2048,
) -> Tuple[Path, str]:
    """
    Removes the background of the source image and saves a transparent PNG.

    Returns:
        (result_path, result_filename)
    """
    logger.info("Removing background for image: %s", source_image_path)
    image = load_image(source_image_path)
    image, _ = resize_to_max_dimension(image, max_dimension)

    # Process with rembg (removes background, returns RGBA PIL image)
    output_image = rembg.remove(image)

    # Save as transparent PNG
    result_filename = generate_unique_filename(f"nobg_{source_image_path.stem}.png")
    result_path = result_folder / result_filename
    output_image.save(result_path, format="PNG")

    logger.info("Background removed successfully: %s", result_path)
    return result_path, result_filename

