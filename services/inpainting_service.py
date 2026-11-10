"""
services/inpainting_service.py
-------------------------------
High-level orchestration for the "remove object" workflow: takes a saved
source image + a raw mask payload, prepares both, dispatches to the
configured AI backend (LaMa or SDXL), and persists the result.

This is the module app.py's routes call into -- it hides all model- and
image-processing detail behind one simple function: `remove_object()`.
"""

from pathlib import Path
from typing import Tuple

from PIL import Image

from services.image_service import (
    image_to_bytes,
    load_image,
    mask_has_content,
    prepare_mask,
    resize_to_max_dimension,
    save_image,
)
from utils.file_utils import generate_unique_filename
from utils.logger import get_logger
from utils.validators import ValidationError

logger = get_logger(__name__)


class InpaintingService:
    """
    Facade over the configured inpainting backend.

    The backend model is injected/lazily loaded on first use so that the
    (potentially slow, multi-second) model load happens once per process
    rather than blocking app startup or every request.
    """

    def __init__(self, config):
        self.config = config
        self._backend = config.INPAINT_BACKEND.lower()
        self._model = None  # lazy-loaded on first request

    def _get_model(self):
        """Lazily instantiate and cache the configured model backend."""
        if self._model is not None:
            return self._model

        if self._backend == "lama":
            from models.lama_model import get_lama_model

            self._model = get_lama_model(
                device=self.config.DEVICE, cache_dir=str(self.config.MODEL_CACHE_DIR)
            )
        elif self._backend == "sdxl":
            from models.sdxl_model import get_sdxl_model

            self._model = get_sdxl_model(
                model_id=self.config.SDXL_MODEL_ID,
                device=self.config.DEVICE,
                cache_dir=str(self.config.MODEL_CACHE_DIR),
                steps=self.config.SDXL_STEPS,
                guidance_scale=self.config.SDXL_GUIDANCE_SCALE,
            )
        else:
            raise ValueError(f"Unknown INPAINT_BACKEND: {self._backend!r}")

        return self._model

    def remove_object(
        self, source_image_path: Path, mask_bytes: bytes
    ) -> Tuple[Path, str]:
        """
        Run the full object-removal pipeline.

        Args:
            source_image_path: path to the previously-uploaded source image.
            mask_bytes: raw PNG/JPEG bytes of the user-drawn mask (white =
                        region to remove).

        Returns:
            (result_path, result_filename) for the generated inpainted image.

        Raises:
            ValidationError: if the mask is empty/invalid.
        """
        logger.info("Starting object removal for %s using backend=%s", source_image_path, self._backend)

        # 1. Load and normalize the source image.
        image = load_image(source_image_path)
        image, _scale = resize_to_max_dimension(image, self.config.MAX_IMAGE_DIMENSION)

        # 2. Prepare the mask: resize to match image, binarize, dilate.
        mask = prepare_mask(
            mask_bytes, target_size=image.size, dilate_px=self.config.MASK_DILATE_PX
        )

        if not mask_has_content(mask):
            raise ValidationError(
                "The selection mask is empty. Please brush over the object you want to remove."
            )

        # 3. Crop to bounding box for much faster CPU inference
        bbox = mask.getbbox()
        if bbox:
            left, upper, right, lower = bbox
            pad = 128  # Fixed padding for context
            left = max(0, left - pad)
            upper = max(0, upper - pad)
            right = min(image.width, right + pad)
            lower = min(image.height, lower + pad)

            crop_box = (left, upper, right, lower)
            logger.info("Cropping inference to %s (size: %sx%s)", crop_box, right-left, lower-upper)
            
            image_crop = image.crop(crop_box)
            mask_crop = mask.crop(crop_box)

            # 4. Run inference through the configured backend on the crop
            model = self._get_model()
            result_crop = model.inpaint(image_crop, mask_crop)
            
            # Un-pad if the backend padded the output (e.g. to a multiple of 8)
            expected_width = right - left
            expected_height = lower - upper
            if result_crop.size != (expected_width, expected_height):
                result_crop = result_crop.crop((0, 0, expected_width, expected_height))
            
            # 5. Paste the inpainted crop back into the full-size image
            result_image = image.copy()
            result_image.paste(result_crop, crop_box)
        else:
            # Fallback (shouldn't happen due to mask_has_content)
            model = self._get_model()
            result_image = model.inpaint(image, mask)

        # 4. Persist the result.
        result_filename = generate_unique_filename("result.png")
        result_path = Path(self.config.RESULT_FOLDER) / result_filename
        save_image(result_image, result_path, fmt="PNG")

        logger.info("Object removal complete: %s", result_path)
        return result_path, result_filename
