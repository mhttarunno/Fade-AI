"""
utils/logger.py
----------------
Application-wide logging configuration.

Provides a single `get_logger` factory so every module logs in a consistent
format, to both the console and a rotating log file.
"""

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_initialized = False


def _configure_root_logger(log_dir: Path) -> None:
    """Attach console + rotating file handlers to the root logger (once)."""
    global _initialized
    if _initialized:
        return

    log_dir.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)

    file_handler = RotatingFileHandler(
        log_dir / "app.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(console_handler)
    root.addHandler(file_handler)

    _initialized = True


def get_logger(name: str, log_dir: str | Path = "logs") -> logging.Logger:
    """Return a module-level logger, configuring handlers on first call."""
    _configure_root_logger(Path(log_dir))
    return logging.getLogger(name)
