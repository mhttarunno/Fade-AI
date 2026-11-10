"""
utils/validators.py
--------------------
Input validation helpers for file uploads and base64 mask payloads.

Keeping validation logic isolated makes it easy to unit test and reuse across
routes, and keeps app.py focused on request orchestration only.
"""

import base64
import binascii
import io
from typing import Optional, Tuple

from PIL import Image, UnidentifiedImageError
from werkzeug.datastructures import FileStorage


class ValidationError(Exception):
    """Raised when incoming request data fails validation."""


def allowed_file(filename: str, allowed_extensions: set) -> bool:
    """Check whether a filename has an allowed extension."""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed_extensions


def validate_image_file(
    file_storage: FileStorage, allowed_extensions: set, max_bytes: int
) -> None:
    """
    Validate an uploaded image file for extension, real content type, and size.

    Raises ValidationError with a user-friendly message on failure.
    """
    if file_storage is None or file_storage.filename == "":
        raise ValidationError("No file was selected for upload.")

    if not allowed_file(file_storage.filename, allowed_extensions):
        raise ValidationError(
            f"Unsupported file extension. Allowed types: {', '.join(sorted(allowed_extensions))}."
        )

    # Verify the actual file content is a decodable image (defends against a
    # malicious/corrupt file renamed to .png, .jpg, etc.)
    try:
        raw = file_storage.stream.read()
        file_storage.stream.seek(0)
        with Image.open(io.BytesIO(raw)) as img:
            img.verify()
        if Image.open(io.BytesIO(raw)).format.lower() not in {"png", "jpeg", "webp"}:
            raise ValidationError("The uploaded file is not a valid image.")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationError("The uploaded file is not a valid image.") from exc

    # Validate size by seeking to end of stream.
    file_storage.stream.seek(0, 2)  # seek to end
    size = file_storage.stream.tell()
    file_storage.stream.seek(0)
    if size > max_bytes:
        raise ValidationError(
            f"File is too large ({size / (1024 * 1024):.1f} MB). "
            f"Maximum allowed size is {max_bytes / (1024 * 1024):.0f} MB."
        )


def decode_base64_mask(data_url: str) -> bytes:
    """
    Decode a base64 data-URL (e.g. 'data:image/png;base64,...') into raw bytes.

    Raises ValidationError if the payload is missing or malformed.
    """
    if not data_url:
        raise ValidationError("No mask data was provided.")

    try:
        if "," in data_url:
            _, encoded = data_url.split(",", 1)
        else:
            encoded = data_url
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError("Mask data is corrupted or improperly encoded.") from exc


def validate_mask_bytes(mask_bytes: bytes) -> None:
    """Ensure decoded mask bytes represent a real image."""
    try:
        with Image.open(io.BytesIO(mask_bytes)) as img:
            img.verify()
        fmt = Image.open(io.BytesIO(mask_bytes)).format
        if fmt is None or fmt.lower() not in {"png", "jpeg"}:
            raise ValidationError("Mask payload is not a valid image.")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationError("Mask payload is not a valid image.") from exc
