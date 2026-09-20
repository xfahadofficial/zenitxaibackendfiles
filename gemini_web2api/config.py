"""Configuration management."""
import json
import os

DEFAULT_CONFIG = {
    "port": 8081,
    "host": "0.0.0.0",
    "retry_attempts": 3,
    "retry_delay_sec": 2,
    "request_timeout_sec": 180,
    "gemini_bl": "boq_assistant-bard-web-server_20260716.08_p0",
    "auth_user": None,
    "xsrf_token": None,
    "default_model": "gemini-3.6-flash",
    "log_requests": True,
    "cookie_file": None,
    "proxy": None,
    "api_keys": [],
    "temporary_chats": False,
    "hf_token": None,
    "hf_image_model": "black-forest-labs/FLUX.1-schnell",
    "image_width": 1024,
    "image_height": 1024,
}

CONFIG = dict(DEFAULT_CONFIG)


def load_config(path: str = None):
    """Load config from JSON file and environment variables."""
    if path and os.path.exists(path):
        with open(path) as f:
            CONFIG.update(json.load(f))
    
    # Override with environment variables for Hugging Face settings
    if os.getenv("HF_TOKEN"):
        CONFIG["hf_token"] = os.getenv("HF_TOKEN")
    if os.getenv("HF_IMAGE_MODEL"):
        CONFIG["hf_image_model"] = os.getenv("HF_IMAGE_MODEL")
    if os.getenv("IMAGE_WIDTH"):
        CONFIG["image_width"] = int(os.getenv("IMAGE_WIDTH"))
    if os.getenv("IMAGE_HEIGHT"):
        CONFIG["image_height"] = int(os.getenv("IMAGE_HEIGHT"))
    
    return CONFIG


def find_config():
    """Search for config file in standard locations."""
    for p in ["./config.json", os.path.expanduser("~/.config/gemini-web2api/config.json")]:
        if os.path.exists(p):
            return p
    return None
