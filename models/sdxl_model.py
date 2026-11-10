"""
models/sdxl_model.py
---------------------
Wrapper around the Stable Diffusion XL Inpainting pipeline (Hugging Face
Diffusers). This backend produces higher-fidelity, more "creative" fills than
LaMa at the cost of needing more VRAM and several seconds-to-tens-of-seconds
per image, even on GPU. It is offered as an optional/alternate backend
(INPAINT_BACKEND=sdxl) for users who prioritize quality over speed.

Since object *removal* (not object replacement) is the goal, we use a neutral
background-completion prompt by default so the model tries to seamlessly
extend the surrounding scene rather than hallucinate a new object.
"""

import threading
from typing import Optional

import torch
from PIL import Image

from utils.logger import get_logger

logger = get_logger(__name__)

_model_lock = threading.Lock()
_model_instance: Optional["SDXLInpainter"] = None

DEFAULT_REMOVAL_PROMPT = (
    "seamless background, empty space, natural continuation of surrounding "
    "textures and lighting, photorealistic, high detail"
)
DEFAULT_NEGATIVE_PROMPT = (
    "object, artifact, watermark, text, blurry, distorted, low quality, extra limbs"
)


class SDXLInpainter:
    """Thin wrapper around diffusers' StableDiffusionXLInpaintPipeline."""

    def __init__(
        self,
        model_id: str,
        device: str = "auto",
        cache_dir: Optional[str] = None,
        steps: int = 30,
        guidance_scale: float = 7.5,
    ):
        from diffusers import AutoPipelineForInpainting

        self.device = self._resolve_device(device)
        self.steps = steps
        self.guidance_scale = guidance_scale

        logger.info("Loading SDXL inpainting pipeline '%s' on %s ...", model_id, self.device)

        dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.pipe = AutoPipelineForInpainting.from_pretrained(
            model_id,
            torch_dtype=dtype,
            cache_dir=cache_dir,
            variant="fp16" if self.device == "cuda" else None,
            use_safetensors=True,
        )
        self.pipe.to(self.device)

        if self.device == "cuda":
            self.pipe.enable_attention_slicing()

        logger.info("SDXL inpainting pipeline loaded successfully.")

    @staticmethod
    def _resolve_device(device: str) -> str:
        if device == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        return device

    def inpaint(
        self,
        image: Image.Image,
        mask: Image.Image,
        prompt: str = DEFAULT_REMOVAL_PROMPT,
        negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
    ) -> Image.Image:
        """
        Run SDXL inpainting on `image` using `mask` (white = area to fill).

        SDXL works best at 1024x1024; we resize up for inference and back
        down to the original resolution afterward to preserve output size.
        """
        original_size = image.size
        work_size = (1024, 1024)

        image_rgb = image.convert("RGB").resize(work_size)
        mask_l = mask.convert("L").resize(work_size)

        generator = torch.Generator(device=self.device).manual_seed(42)

        result = self.pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            image=image_rgb,
            mask_image=mask_l,
            num_inference_steps=self.steps,
            guidance_scale=self.guidance_scale,
            generator=generator,
        ).images[0]

        return result.resize(original_size)


def get_sdxl_model(
    model_id: str,
    device: str = "auto",
    cache_dir: Optional[str] = None,
    steps: int = 30,
    guidance_scale: float = 7.5,
) -> SDXLInpainter:
    """Return a process-wide singleton SDXLInpainter, creating it if needed."""
    global _model_instance
    if _model_instance is None:
        with _model_lock:
            if _model_instance is None:
                _model_instance = SDXLInpainter(
                    model_id=model_id,
                    device=device,
                    cache_dir=cache_dir,
                    steps=steps,
                    guidance_scale=guidance_scale,
                )
    return _model_instance
