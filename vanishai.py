"""
vanishai.py
-----------
Flask application entrypoint for VanishAI - Intelligent Object Removal & AI Photo Studio.

Routes:
    GET  /                            -> main UI (upload, canvas editor, results, dashboard)
    POST /api/upload                  -> upload + validate source image
    POST /api/remove-object           -> brush/lasso AI inpainting
    POST /api/detect-objects          -> smart object detection (COCO 80 categories)
    POST /api/remove-background       -> background remover (transparent PNG)
    POST /api/enhance-image           -> 2x/4x super-resolution, sharpen & denoise
    POST /api/batch-process           -> batch multi-image processing & zip creation
    GET  /api/history                 -> recent editing history
    POST /api/history/save            -> save history item
    GET  /api/stats                   -> usage dashboard metrics
    GET  /api/download/<f>            -> download result / zip file
    GET  /api/health                  -> readiness & device health check
"""

import os
import time
import traceback
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from werkzeug.exceptions import RequestEntityTooLarge

from config import config_map
from services.background_service import remove_background
from services.batch_service import create_batch_zip
from services.detection_service import detect_objects
from services.enhancement_service import enhance_image
from services.history_and_stats_service import get_history, get_stats, record_action
from services.inpainting_service import InpaintingService
from utils.file_utils import cleanup_old_files, save_upload
from utils.logger import get_logger
from utils.validators import (
    ValidationError,
    decode_base64_mask,
    validate_image_file,
    validate_mask_bytes,
)

logger = get_logger(__name__)


def create_app(env: str = None) -> Flask:
    """Application factory: builds and configures the Flask app instance."""
    env = env or os.environ.get("FLASK_ENV", "default")
    app_config = config_map.get(env, config_map["default"])

    app = Flask(__name__)
    app.config.from_object(app_config)
    app_config.init_app(app)

    inpainting_service = InpaintingService(app_config)

    def _resolve_image_path(filename: str) -> Optional[Path]:
        """Resolves filename within upload or result folders, blocking traversal."""
        if not filename:
            return None
        upload_root = Path(app.config["UPLOAD_FOLDER"]).resolve()
        result_root = Path(app.config["RESULT_FOLDER"]).resolve()

        source_path = (upload_root / filename).resolve()
        if source_path.exists() and (upload_root in source_path.parents or source_path == upload_root):
            return source_path

        result_path = (result_root / filename).resolve()
        if result_path.exists() and (result_root in result_path.parents or result_path == result_root):
            return result_path

        return None

    # ------------------------------------------------------------------
    # Page routes
    # ------------------------------------------------------------------

    @app.route("/")
    def index():
        return render_template("index.html")

    # ------------------------------------------------------------------
    # Core Inpainting & Upload
    # ------------------------------------------------------------------

    @app.route("/api/upload", methods=["POST"])
    def upload_image():
        """Validate and store an uploaded source image; return its URL/id."""
        try:
            file_storage = request.files.get("image")
            validate_image_file(
                file_storage,
                allowed_extensions=app.config["ALLOWED_EXTENSIONS"],
                max_bytes=app.config["MAX_CONTENT_LENGTH"],
            )

            cleanup_old_files(app.config["UPLOAD_FOLDER"], app.config["FILE_RETENTION_MINUTES"])
            cleanup_old_files(app.config["RESULT_FOLDER"], app.config["FILE_RETENTION_MINUTES"])

            saved_path = save_upload(file_storage, app.config["UPLOAD_FOLDER"])

            return jsonify(
                {
                    "success": True,
                    "filename": saved_path.name,
                    "url": f"/static/uploads/{saved_path.name}",
                }
            )

        except ValidationError as exc:
            logger.warning("Upload validation failed: %s", exc)
            return jsonify({"success": False, "error": str(exc)}), 400
        except RequestEntityTooLarge:
            return jsonify({"success": False, "error": "Uploaded file exceeds the size limit."}), 413
        except Exception:
            logger.error("Unexpected error during upload:\n%s", traceback.format_exc())
            return jsonify({"success": False, "error": "An unexpected server error occurred."}), 500

    @app.route("/api/remove-object", methods=["POST"])
    def remove_object_route():
        """Run AI inpainting on a previously-uploaded image using a drawn mask."""
        start_time = time.time()
        try:
            payload = request.get_json(silent=True) or {}
            filename = payload.get("filename")
            mask_data_url = payload.get("mask")

            resolved = _resolve_image_path(filename)
            if not resolved:
                return jsonify({"success": False, "error": "Source image not found. Please re-upload."}), 404

            mask_bytes = decode_base64_mask(mask_data_url)
            validate_mask_bytes(mask_bytes)

            result_path, result_filename = inpainting_service.remove_object(resolved, mask_bytes)

            elapsed = round(time.time() - start_time, 2)
            record_action("remove_object", filename, result_filename, elapsed)
            logger.info("Inpainting request completed in %.2fs", elapsed)

            return jsonify(
                {
                    "success": True,
                    "result_url": f"/static/results/{result_filename}",
                    "result_filename": result_filename,
                    "processing_time_seconds": elapsed,
                }
            )

        except ValidationError as exc:
            logger.warning("Remove-object validation failed: %s", exc)
            return jsonify({"success": False, "error": str(exc)}), 400
        except FileNotFoundError:
            return jsonify({"success": False, "error": "Source image not found. Please re-upload."}), 404
        except Exception:
            logger.error("Unexpected error during inpainting:\n%s", traceback.format_exc())
            return jsonify({"success": False, "error": "AI processing failed. Please try again."}), 500

    # ------------------------------------------------------------------
    # Feature 1: Smart Object Detection
    # ------------------------------------------------------------------

    @app.route("/api/detect-objects", methods=["POST"])
    def detect_objects_route():
        """Detect common objects in the image (people, cars, animals, etc.)."""
        start_time = time.time()
        try:
            payload = request.get_json(silent=True) or {}
            filename = payload.get("filename")
            threshold = float(payload.get("threshold", 0.40))

            resolved = _resolve_image_path(filename)
            if not resolved:
                return jsonify({"success": False, "error": "Image not found."}), 404

            objects = detect_objects(
                resolved,
                score_threshold=threshold,
                device=app.config.get("DEVICE", "cpu"),
            )

            elapsed = round(time.time() - start_time, 2)
            record_action("detect_objects", filename, None, elapsed, {"count": len(objects)})

            return jsonify(
                {
                    "success": True,
                    "objects": objects,
                    "count": len(objects),
                    "processing_time_seconds": elapsed,
                }
            )
        except Exception as exc:
            logger.error("Object detection failed:\n%s", traceback.format_exc())
            return jsonify({"success": False, "error": f"Object detection failed: {str(exc)}"}), 500

    # ------------------------------------------------------------------
    # Feature 2: Background Remover
    # ------------------------------------------------------------------

    @app.route("/api/remove-background", methods=["POST"])
    def remove_background_route():
        """Automatically isolate subject and export transparent PNG."""
        start_time = time.time()
        try:
            payload = request.get_json(silent=True) or {}
            filename = payload.get("filename")

            resolved = _resolve_image_path(filename)
            if not resolved:
                return jsonify({"success": False, "error": "Image not found."}), 404

            results_dir = Path(app.config["RESULT_FOLDER"]).resolve()
            result_path, result_filename = remove_background(
                source_image_path=resolved,
                result_folder=results_dir,
                max_dimension=app.config.get("MAX_IMAGE_DIMENSION", 2048),
            )

            elapsed = round(time.time() - start_time, 2)
            record_action("remove_background", filename, result_filename, elapsed)

            return jsonify(
                {
                    "success": True,
                    "result_url": f"/static/results/{result_filename}",
                    "result_filename": result_filename,
                    "processing_time_seconds": elapsed,
                }
            )
        except Exception as exc:
            logger.error("Background removal failed:\n%s", traceback.format_exc())
            return jsonify({"success": False, "error": "Background removal failed. Please try again."}), 500

    # ------------------------------------------------------------------
    # Feature 3: AI Image Enhancement
    # ------------------------------------------------------------------

    @app.route("/api/enhance-image", methods=["POST"])
    def enhance_image_route():
        """Upscale (2x/4x), sharpen, and denoise image."""
        start_time = time.time()
        try:
            payload = request.get_json(silent=True) or {}
            filename = payload.get("filename")
            scale = int(payload.get("scale", 2))
            denoise = bool(payload.get("denoise", True))
            sharpen = bool(payload.get("sharpen", True))
            enhance_contrast = bool(payload.get("enhance_contrast", True))

            resolved = _resolve_image_path(filename)
            if not resolved:
                return jsonify({"success": False, "error": "Image not found."}), 404

            results_dir = Path(app.config["RESULT_FOLDER"]).resolve()
            result_path, result_filename = enhance_image(
                source_image_path=resolved,
                result_folder=results_dir,
                scale=scale,
                denoise=denoise,
                sharpen=sharpen,
                enhance_contrast=enhance_contrast,
            )

            elapsed = round(time.time() - start_time, 2)
            record_action("enhance_image", filename, result_filename, elapsed, {"scale": scale})

            return jsonify(
                {
                    "success": True,
                    "result_url": f"/static/results/{result_filename}",
                    "result_filename": result_filename,
                    "scale": scale,
                    "processing_time_seconds": elapsed,
                }
            )
        except Exception as exc:
            logger.error("Image enhancement failed:\n%s", traceback.format_exc())
            return jsonify({"success": False, "error": "Image enhancement failed."}), 500

    # ------------------------------------------------------------------
    # Feature 6: Batch Processing
    # ------------------------------------------------------------------

    @app.route("/api/batch-process", methods=["POST"])
    def batch_process_route():
        """Process multiple images in a batch and package results into a ZIP."""
        start_time = time.time()
        try:
            files = request.files.getlist("images")
            operation = request.form.get("operation", "remove_background")  # "remove_background" | "enhance"

            if not files or len(files) == 0:
                return jsonify({"success": False, "error": "No images provided for batch processing."}), 400

            upload_folder = Path(app.config["UPLOAD_FOLDER"]).resolve()
            results_dir = Path(app.config["RESULT_FOLDER"]).resolve()

            processed_items = []
            result_paths = []

            for f in files:
                if not f.filename:
                    continue
                saved_source = save_upload(f, upload_folder)
                res_path = None
                res_name = None

                if operation == "remove_background":
                    res_path, res_name = remove_background(saved_source, results_dir)
                elif operation == "enhance":
                    res_path, res_name = enhance_image(saved_source, results_dir, scale=2)
                else:
                    # Default: background removal
                    res_path, res_name = remove_background(saved_source, results_dir)

                if res_path and res_path.exists():
                    result_paths.append(res_path)
                    processed_items.append({
                        "original_filename": saved_source.name,
                        "result_filename": res_name,
                        "result_url": f"/static/results/{res_name}",
                    })

            if not result_paths:
                return jsonify({"success": False, "error": "None of the images could be processed."}), 400

            zip_path, zip_filename = create_batch_zip(result_paths, results_dir, batch_prefix=f"batch_{operation}")
            elapsed = round(time.time() - start_time, 2)
            record_action("batch_process", f"{len(files)}_images", zip_filename, elapsed, {"operation": operation, "count": len(result_paths)})

            return jsonify({
                "success": True,
                "count": len(processed_items),
                "items": processed_items,
                "zip_url": f"/static/results/{zip_filename}",
                "zip_filename": zip_filename,
                "processing_time_seconds": elapsed,
            })
        except Exception as exc:
            logger.error("Batch processing failed:\n%s", traceback.format_exc())
            return jsonify({"success": False, "error": f"Batch processing failed: {str(exc)}"}), 500

    # ------------------------------------------------------------------
    # Features 7 & 10: History & Usage Dashboard
    # ------------------------------------------------------------------

    @app.route("/api/history", methods=["GET"])
    def get_history_route():
        """Retrieve recent project editing history."""
        limit = int(request.args.get("limit", 20))
        items = get_history(limit=limit)
        return jsonify({"success": True, "history": items})

    @app.route("/api/history/save", methods=["POST"])
    def save_history_route():
        """Manually save or label an item in history."""
        payload = request.get_json(silent=True) or {}
        action = payload.get("action", "custom_edit")
        orig = payload.get("original_filename", "")
        res = payload.get("result_filename", "")
        meta = payload.get("metadata", {})
        entry = record_action(action, orig, res, 0.0, meta)
        return jsonify({"success": True, "entry": entry})

    @app.route("/api/stats", methods=["GET"])
    def get_stats_route():
        """Retrieve usage statistics and metrics."""
        stats = get_stats()
        return jsonify({"success": True, "stats": stats})

    # ------------------------------------------------------------------
    # Utility & Downloads
    # ------------------------------------------------------------------

    @app.route("/api/download/<path:filename>")
    def download_result(filename):
        """Serve a generated result image or ZIP archive as a downloadable attachment."""
        results_dir = Path(app.config["RESULT_FOLDER"]).resolve()
        target = (results_dir / filename).resolve()

        if results_dir not in target.parents and target != results_dir:
            return jsonify({"success": False, "error": "Invalid filename."}), 400
        if not target.exists():
            return jsonify({"success": False, "error": "File not found."}), 404

        return send_from_directory(results_dir, filename, as_attachment=True)

    @app.route("/api/health")
    def health():
        """Health check reporting configured backend, features, and device."""
        import torch

        return jsonify(
            {
                "status": "ok",
                "backend": app.config["INPAINT_BACKEND"],
                "cuda_available": torch.cuda.is_available(),
                "device": app.config["DEVICE"],
                "features": [
                    "object_removal",
                    "smart_object_detection",
                    "background_remover",
                    "image_enhancement",
                    "batch_processing",
                    "editing_history",
                    "usage_dashboard",
                ],
            }
        )

    # ------------------------------------------------------------------
    # Error handlers
    # ------------------------------------------------------------------

    @app.errorhandler(413)
    def handle_file_too_large(_error):
        return jsonify({"success": False, "error": "Uploaded file exceeds the size limit."}), 413

    @app.errorhandler(404)
    def handle_not_found(_error):
        if request.path.startswith("/api/"):
            return jsonify({"success": False, "error": "Resource not found."}), 404
        return render_template("index.html"), 404

    @app.errorhandler(500)
    def handle_server_error(_error):
        logger.error("Internal server error:\n%s", traceback.format_exc())
        return jsonify({"success": False, "error": "Internal server error."}), 500

    return app


# WSGI entrypoint
app = create_app()


if __name__ == "__main__":
    debug_mode = app.config.get("DEBUG", False)
    port = int(os.environ.get("PORT", 5000))
    logger.info("Starting VanishAI app on port %d (debug=%s)", port, debug_mode)
    app.run(host="0.0.0.0", port=port, debug=debug_mode, use_reloader=False)
