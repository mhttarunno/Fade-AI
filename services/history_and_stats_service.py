"""
services/history_and_stats_service.py
--------------------------------------
Persistent storage for edit history and real usage statistics.
Maintains logs/history.json and logs/stats.json with thread-safe file operations.
"""

import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from utils.logger import get_logger

logger = get_logger(__name__)

_LOCK = threading.Lock()
_DATA_DIR = Path("logs")
_HISTORY_FILE = _DATA_DIR / "history.json"
_STATS_FILE = _DATA_DIR / "stats.json"

DEFAULT_STATS = {
    "total_processed": 0,
    "objects_removed": 0,
    "backgrounds_removed": 0,
    "objects_detected": 0,
    "objects_replaced": 0,
    "images_enhanced": 0,
    "batch_processed": 0,
    "total_processing_seconds": 0.0,
    "avg_processing_time": 0.0,
    "last_updated": None,
}


def _ensure_files():
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not _HISTORY_FILE.exists():
        _HISTORY_FILE.write_text("[]", encoding="utf-8")
    if not _STATS_FILE.exists():
        _STATS_FILE.write_text(json.dumps(DEFAULT_STATS, indent=2), encoding="utf-8")


def record_action(
    action: str,
    original_filename: str,
    result_filename: Optional[str] = None,
    elapsed_seconds: float = 0.0,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Records an activity to history and increments global statistics."""
    with _LOCK:
        try:
            _ensure_files()

            # 1. Update History
            try:
                history_data: List[Dict[str, Any]] = json.loads(
                    _HISTORY_FILE.read_text(encoding="utf-8")
                )
            except Exception:
                history_data = []

            entry = {
                "id": f"hist_{int(time.time() * 1000)}",
                "timestamp": time.time(),
                "formatted_time": time.strftime("%b %d, %Y %I:%M %p"),
                "action": action,
                "original_filename": original_filename,
                "result_filename": result_filename or original_filename,
                "original_url": f"/static/uploads/{original_filename}",
                "result_url": f"/static/results/{result_filename}" if result_filename else f"/static/uploads/{original_filename}",
                "elapsed_seconds": round(elapsed_seconds, 2),
                "metadata": metadata or {},
            }

            # Prepend newest entry, keep up to 100 entries
            history_data.insert(0, entry)
            history_data = history_data[:100]
            _HISTORY_FILE.write_text(json.dumps(history_data, indent=2), encoding="utf-8")

            # 2. Update Stats
            try:
                stats: Dict[str, Any] = json.loads(_STATS_FILE.read_text(encoding="utf-8"))
            except Exception:
                stats = dict(DEFAULT_STATS)

            stats["total_processed"] = stats.get("total_processed", 0) + 1
            stats["total_processing_seconds"] = round(
                stats.get("total_processing_seconds", 0.0) + elapsed_seconds, 2
            )
            if stats["total_processed"] > 0:
                stats["avg_processing_time"] = round(
                    stats["total_processing_seconds"] / stats["total_processed"], 2
                )
            stats["last_updated"] = time.strftime("%Y-%m-%d %H:%M:%S")

            action_key_map = {
                "remove_object": "objects_removed",
                "remove_background": "backgrounds_removed",
                "detect_objects": "objects_detected",
                "enhance_image": "images_enhanced",
                "batch_process": "batch_processed",
            }
            stat_key = action_key_map.get(action)
            if stat_key:
                stats[stat_key] = stats.get(stat_key, 0) + 1

            _STATS_FILE.write_text(json.dumps(stats, indent=2), encoding="utf-8")
            return entry
        except Exception as exc:
            logger.error("Failed to record history/stats: %s", exc)
            return {}


def get_history(limit: int = 20) -> List[Dict[str, Any]]:
    """Returns recent edit history."""
    with _LOCK:
        _ensure_files()
        try:
            items = json.loads(_HISTORY_FILE.read_text(encoding="utf-8"))
            return items[:limit]
        except Exception as exc:
            logger.error("Failed to read history: %s", exc)
            return []


def get_stats() -> Dict[str, Any]:
    """Returns global usage statistics."""
    with _LOCK:
        _ensure_files()
        try:
            return json.loads(_STATS_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.error("Failed to read stats: %s", exc)
            return dict(DEFAULT_STATS)

