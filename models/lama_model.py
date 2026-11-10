"""
models/lama_model.py
---------------------
Wrapper around the LaMa (Large Mask Inpainting) model.

LaMa is a fast, fully-convolutional inpainting network that is purpose-built
for exactly this use case (removing large masked regions and synthesizing
plausible background), which makes it the recommended default backend for
this app: lower VRAM footprint than diffusion models, no text prompt needed,
and near-instant inference on GPU (a few seconds on CPU for modest image
sizes).

We use the `simple-lama-inpainting` package, which bundles a torch-scripted
LaMa checkpoint (trained by the original authors on the "Big LaMa" config)
and handles weight download/caching automatically on first use.

The model is loaded lazily and cached as a singleton so repeated requests do
not pay the model-load cost more than once per process.
"""

import threading
from typing import Optional

import numpy as np
import torch
from PIL import Image

from utils.logger import get_logger

logger = get_logger(__name__)

_model_lock = threading.Lock()
_model_instance: Optional["LamaInpainter"] = None


class LamaInpainter:
    """Thin, thread-safe wrapper around the SimpleLama inpainting model."""

    def __init__(self, device: str = "auto", cache_dir: Optional[str] = None):
        self.device = self._resolve_device(device)
        logger.info("Loading LaMa inpainting model on device=%s ...", self.device)

        # Imported lazily so the (fairly heavy) dependency is only required
        # when the LaMa backend is actually selected.
        from simple_lama_inpainting import SimpleLama

        # SimpleLama auto-detects CUDA internally; we set the env-driven
        # torch default device beforehand so it respects our config.
        if self.device == "cpu":
            torch.set_num_threads(max(1, torch.get_num_threads()))

        # Monkey-patch torch.jit.load to enforce map_location so that we don't
        # hit CUDA errors if the system's PyTorch installation lacks full CUDA support.
        _original_load = torch.jit.load
        try:
            torch.jit.load = lambda *args, **kwargs: _original_load(*args, **{**kwargs, 'map_location': self.device})
            self._lama = SimpleLama(device=self.device)
        finally:
            torch.jit.load = _original_load

        logger.info("LaMa model loaded successfully.")

    @staticmethod
    def _resolve_device(device: str) -> str:
        if device == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        return device

    def inpaint(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        """
        Run inpainting.

        Args:
            image: RGB PIL image (the original photo).
            mask: single-channel (L) PIL image, same size as `image`, where
                  white (255) pixels mark the region to remove/fill and black
                  (0) pixels are kept untouched.

        Returns:
            A new RGB PIL image with the masked region inpainted.
        """
        if image.size != mask.size:
            raise ValueError(
                f"Image size {image.size} and mask size {mask.size} must match."
            )

        image_rgb = image.convert("RGB")
        mask_l = mask.convert("L")

        result = self._lama(image_rgb, mask_l)

        # simple-lama-inpainting returns a PIL.Image already; guard in case a
        # future version returns a numpy array instead.
        if isinstance(result, np.ndarray):
            result = Image.fromarray(result.astype("uint8"), "RGB")

        return result


def get_lama_model(device: str = "auto", cache_dir: Optional[str] = None) -> LamaInpainter:
    """Return a process-wide singleton LamaInpainter, creating it if needed."""
    global _model_instance
    if _model_instance is None:
        with _model_lock:
            if _model_instance is None:  # double-checked locking
                _model_instance = LamaInpainter(device=device, cache_dir=cache_dir)
    return _model_instance
