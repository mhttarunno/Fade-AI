"""
services/batch_service.py
-------------------------
Batch processing manager and ZIP archive generator.
Allows users to upload multiple photos, queue operations (background removal,
enhancement, or auto-cleanup), and download all results in a single ZIP.
"""

import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from utils.file_utils import generate_unique_filename
from utils.logger import get_logger

logger = get_logger(__name__)


def create_batch_zip(
    result_paths: List[Path],
    result_folder: Path,
    batch_prefix: str = "batch_results",
) -> Tuple[Path, str]:
    """
    Packages a list of result image paths into a single downloadable .zip archive.
    """
    zip_filename = generate_unique_filename(f"{batch_prefix}_{int(time.time())}.zip")
    zip_path = result_folder / zip_filename

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in result_paths:
            if p.exists():
                zf.write(p, arcname=p.name)

    logger.info("Created batch ZIP file at: %s with %d files", zip_path, len(result_paths))
    return zip_path, zip_filename
