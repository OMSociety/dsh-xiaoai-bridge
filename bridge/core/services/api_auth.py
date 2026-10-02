"""
Bearer-token gate for the bridge's HTTP API Server.

The upstream API Server exposes nine endpoints with no authentication at all. On
loopback that is a local convenience, but the listening address is a setting
(`API_SERVER_HOST`), and `0.0.0.0` would hand every host on the LAN a remote
control for the speaker: play arbitrary text, URLs or files through it, wake it,
interrupt it, and synthesise TTS with the configured cloud credentials.

One rule, applied in front of every route:

- Loopback peers are served without a token. A process that can reach
  127.0.0.1 on this machine can already read the credential store, so a token
  there would be friction and not a boundary — and it would break the local
  helpers that have no way to learn the secret.
- Every other peer must present ``Authorization: Bearer <token>``. When no
  token is configured at all, non-loopback peers are refused outright: there is
  nothing to check against, and the API Server must not be steerable from the
  network just because a secret is missing.

The token is the shared secret the plugin launches the bridge with
(``XIAOAI_API_TOKEN``), with the rendered ``dsh.token`` as the fallback for a
manual run — the same precedence `core/dsh.py` uses for plugin-bound calls.
"""

from __future__ import annotations

import hmac
import ipaddress
import os

from aiohttp import web

from core.utils.logger import logger

#: Spawn-environment variable carrying the shared secret (see `core/dsh.py`).
TOKEN_ENV_VAR = "XIAOAI_API_TOKEN"

#: Config section/key the plugin renders the token into, as a manual-run fallback.
TOKEN_CONFIG_SECTION = "dsh"
TOKEN_CONFIG_KEY = "token"

#: Body returned to a caller that is not allowed through. Deliberately says
#: nothing about which half of the check failed.
UNAUTHORIZED_BODY = {"success": False, "error": "unauthorized"}


def configured_token() -> str:
    """
    The bearer token this API Server expects, or ``''`` when none is configured.

    Read per request rather than cached, so a config hot-reload (the bridge
    polls the rendered file every second) also changes the expected secret.
    """
    env_token = os.environ.get(TOKEN_ENV_VAR)
    if env_token and env_token.strip():
        return env_token.strip()
    try:
        from core.utils.config import ConfigManager

        config = ConfigManager.instance().get_app_config(TOKEN_CONFIG_SECTION, {}) or {}
    except Exception as exc:  # pragma: no cover - defensive: config may not be loaded yet
        logger.warning(f"[APIServer] could not read the API token from config: {exc}")
        return ""
    return str(config.get(TOKEN_CONFIG_KEY, "") or "").strip()


def bearer_of(headers) -> str:
    """
    Pull the token out of an ``Authorization: Bearer ...`` header.

    ``headers`` is a case-insensitive mapping (aiohttp's CIMultiDict). The scheme
    is matched case-insensitively and the value is trimmed, because a caller that
    sends ``bearer  <token> `` means the same thing.
    """
    raw = str(headers.get("Authorization", "") or "").strip() if headers is not None else ""
    scheme = "bearer"
    if raw[: len(scheme)].lower() != scheme or raw[len(scheme) : len(scheme) + 1] != " ":
        return ""
    return raw[len(scheme) :].strip()


def is_loopback(peer: str | None) -> bool:
    """Whether a peer address is this machine (`127.0.0.0/8`, `::1`)."""
    if not peer:
        return False
    try:
        return ipaddress.ip_address(peer).is_loopback
    except ValueError:
        return False


def peer_host(request: web.Request) -> str | None:
    """The peer address of a request, or None when the transport is gone."""
    transport = request.transport
    if transport is None:
        return None
    peername = transport.get_extra_info("peername")
    if not peername:
        return None
    return str(peername[0])


def authorize(token: str, provided: str, peer: str | None) -> str | None:
    """
    Decide whether a request may proceed.

    @returns the reason it is refused, or None when it is allowed through.
        The reason is for the log only and never reaches the caller.
    """
    if is_loopback(peer):
        return None
    if not token:
        return f"no API token is configured ({TOKEN_ENV_VAR} or {TOKEN_CONFIG_SECTION}.{TOKEN_CONFIG_KEY})"
    if provided and hmac.compare_digest(provided.encode("utf-8"), token.encode("utf-8")):
        return None
    return "missing or invalid bearer token"


def auth_mode() -> str:
    """How this API Server is gated right now, for logs and health output."""
    return "bearer" if configured_token() else "loopback-only"


@web.middleware
async def bearer_auth(request: web.Request, handler):
    """
    Gate every route of the API Server.

    Installed as an application middleware, so a route added later is covered
    without remembering to add the check.
    """
    host = peer_host(request)
    provided = bearer_of(request.headers)
    reason = authorize(configured_token(), provided, host)
    if reason is not None:
        logger.warning(
            f"[APIServer] refused {request.method} {request.path} from {host or 'unknown'}: {reason}"
        )
        return web.json_response(UNAUTHORIZED_BODY, status=401)
    return await handler(request)
