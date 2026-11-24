"""Credential selection shared by HTTP and conversational Doubao TTS."""
from core.utils.base import get_env


def doubao_credentials(config, request=None):
    request = request or {}
    return (request.get("app_id") or config.get("app_id"),
            request.get("access_key") or get_env("DOUBAO_ACCESS_KEY") or config.get("access_key"))
