"""Local API or dedicated bearer for a paired TLS frontend (including loopback proxy peers)."""

from __future__ import annotations

import hmac
import ipaddress
import os

from aiohttp import web

from core.utils.logger import logger

TOKEN_ENV_VAR = "OPENXIAOAI_REMOTE_TOKEN"

#: Body returned to a caller that is not allowed through. Deliberately says
#: nothing about which half of the check failed.
UNAUTHORIZED_BODY = {"success": False, "error": "unauthorized"}


def configured_token() -> str:
    return os.environ.get(TOKEN_ENV_VAR, "").strip()


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
    if not token and is_loopback(peer):
        return None
    if not token:
        return f"no API token is configured ({TOKEN_ENV_VAR})"
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
