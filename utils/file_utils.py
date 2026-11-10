"""
utils/file_utils.py
--------------------
Filesystem helpers: secure filename generation, saving uploads, and cleanup
of stale generated files so disk usage doesn't grow unbounded.
"""

import time
import uuid
from pathlib import Path

from werkzeug.utils import secure_filename

from utils.logger import get_logger

logger = get_logger(__name__)


def generate_unique_filename(original_filename: str) -> str:
    """
    Build a collision-safe filename: <uuid4>_<sanitized-original-name>.

    Using secure_filename() strips path separators and unsafe characters to
    prevent directory traversal / injection via a crafted filename.
    """
    safe_name = secure_filename(original_filename) or "upload"
    unique_id = uuid.uuid4().hex[:12]
    return f"{unique_id}_{safe_name}"


def save_upload(file_storage, destination_folder: Path) -> Path:
    """Save a validated FileStorage object to disk and return its path."""
    filename = generate_unique_filename(file_storage.filename)
    destination_path = Path(destination_folder) / filename
    file_storage.save(destination_path)
    logger.info("Saved upload to %s", destination_path)
    return destination_path


def cleanup_old_files(folder: Path, retention_minutes: int) -> int:
    """
    Delete files in `folder` older than `retention_minutes`.

    Returns the number of files removed. Safe to call periodically (e.g. from
    a scheduled job or before handling a new request) to avoid disk bloat
    from abandoned uploads/results.
    """
    if not Path(folder).exists():
        return 0

    cutoff = time.time() - (retention_minutes * 60)
    removed = 0
    for path in Path(folder).iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError as exc:
            logger.warning("Failed to remove stale file %s: %s", path, exc)

    if removed:
        logger.info("Cleaned up %d stale file(s) from %s", removed, folder)
    return removed
