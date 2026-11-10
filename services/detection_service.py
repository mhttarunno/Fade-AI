"""
services/detection_service.py
-----------------------------
Smart Object Detection powered by torchvision FasterRCNN MobileNet V3.
Detects people, animals, vehicles, furniture, everyday items with high accuracy and low latency on CPU.
"""

import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw

from services.image_service import load_image
from utils.logger import get_logger

logger = get_logger(__name__)

_MODEL_LOCK = threading.Lock()
_DETECTION_MODEL = None
_WEIGHTS = None
_CATEGORIES = None


def _get_detection_model(device: str = "cpu"):
    global _DETECTION_MODEL, _WEIGHTS, _CATEGORIES
    if _DETECTION_MODEL is not None:
        return _DETECTION_MODEL, _CATEGORIES

    with _MODEL_LOCK:
        if _DETECTION_MODEL is not None:
            return _DETECTION_MODEL, _CATEGORIES

        logger.info("Initializing Object Detection model (FasterRCNN MobileNet V3)...")
        from torchvision.models.detection import (
            FasterRCNN_MobileNet_V3_Large_FPN_Weights,
            fasterrcnn_mobilenet_v3_large_fpn,
        )

        weights = FasterRCNN_MobileNet_V3_Large_FPN_Weights.DEFAULT
        model = fasterrcnn_mobilenet_v3_large_fpn(weights=weights)
        target_device = "cuda" if (device == "cuda" and torch.cuda.is_available()) else "cpu"
        model.to(target_device)
        model.eval()

        _DETECTION_MODEL = model
        _WEIGHTS = weights
        _CATEGORIES = weights.meta["categories"]
        logger.info("Object Detection model loaded successfully (%d categories).", len(_CATEGORIES))
        return _DETECTION_MODEL, _CATEGORIES


def detect_objects(
    image_path: Path,
    score_threshold: float = 0.40,
    device: str = "cpu",
) -> List[Dict[str, Any]]:
    """
    Runs object detection on the target image.

    Returns:
        List of dicts: [
            {
                "id": 1,
                "label": "person",
                "score": 0.94,
                "box": [x1, y1, x2, y2],
                "box_normalized": [nx1, ny1, nx2, ny2],
                "center": [cx, cy],
                "area_percent": 12.5
            }, ...
        ]
    """
    model, categories = _get_detection_model(device=device)
    img_pil = load_image(image_path).convert("RGB")
    width, height = img_pil.size
    total_area = width * height

    # Convert to tensor [C, H, W] normalized [0, 1]
    img_np = np.array(img_pil, dtype=np.float32) / 255.0
    img_tensor = torch.from_numpy(img_np).permute(2, 0, 1)

    target_device = next(model.parameters()).device
    img_tensor = img_tensor.to(target_device)

    with torch.no_grad():
        predictions = model([img_tensor])

    pred = predictions[0]
    boxes = pred["boxes"].cpu().numpy()
    scores = pred["scores"].cpu().numpy()
    labels = pred["labels"].cpu().numpy()

    detected: List[Dict[str, Any]] = []
    for idx, (box, score, label_id) in enumerate(zip(boxes, scores, labels)):
        if score < score_threshold:
            continue

        label_name = categories[label_id] if label_id < len(categories) else f"object_{label_id}"
        x1, y1, x2, y2 = [int(v) for v in box]
        x1 = max(0, min(width, x1))
        y1 = max(0, min(height, y1))
        x2 = max(0, min(width, x2))
        y2 = max(0, min(height, y2))

        w = x2 - x1
        h = y2 - y1
        if w <= 4 or h <= 4:
            continue

        box_area = w * h
        area_pct = round((box_area / total_area) * 100, 2)

        detected.append(
            {
                "id": idx + 1,
                "label": label_name,
                "score": round(float(score), 3),
                "box": [x1, y1, x2, y2],
                "box_normalized": [
                    round(x1 / width, 4),
                    round(y1 / height, 4),
                    round(x2 / width, 4),
                    round(y2 / height, 4),
                ],
                "center": [round((x1 + x2) / 2), round((y1 + y2) / 2)],
                "area_percent": area_pct,
            }
        )

    # Sort largest/most confident first
    detected.sort(key=lambda d: (d["score"], d["area_percent"]), reverse=True)
    return detected


def create_mask_for_boxes(
    image_size: Tuple[int, int],
    boxes: List[List[int]],
    dilate_px: int = 12,
) -> Image.Image:
    """
    Creates a black-and-white mask image (L mode) where boxes are painted white
    and dilated to cover object edges and shadows.
    """
    width, height = image_size
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)

    for box in boxes:
        x1, y1, x2, y2 = box
        draw.rectangle([x1, y1, x2, y2], fill=255)

    # Dilate mask using OpenCV
    mask_np = np.array(mask)
    if dilate_px > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px * 2 + 1, dilate_px * 2 + 1))
        mask_np = cv2.dilate(mask_np, kernel, iterations=1)

    return Image.fromarray(mask_np, mode="L")

