"""
app.py
------
Compatibility wrapper forwarding to vanishai.py.
"""

import os
from vanishai import app, create_app
from utils.logger import get_logger

logger = get_logger(__name__)

if __name__ == "__main__":
    debug_mode = app.config.get("DEBUG", False)
    port = int(os.environ.get("PORT", 5000))
    logger.info("Starting VanishAI app on port %d (debug=%s)", port, debug_mode)
    app.run(host="0.0.0.0", port=port, debug=debug_mode, use_reloader=False)

