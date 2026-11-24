"""Dependency-free client for a local bridge or an explicitly paired HTTPS origin."""
import ipaddress
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


# A loopback call must stay on the same machine, even with system proxies configured.
def _open(req, timeout):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    return opener.open(req, timeout=timeout)


def _origin(value):
    url = urlsplit(value)
    if (url.scheme not in ('https', 'http') or not url.hostname or url.username is not None
            or url.path not in ('', '/') or url.query or url.fragment or '\\' in value
            or any(c.isspace() or ord(c) < 32 for c in value)):
        raise ValueError('桥接地址须为 HTTP(S) origin（仅协议、主机、端口）')
    port = url.port if url.port is not None else (443 if url.scheme == 'https' else 80)
    return url.scheme, url.hostname, port


def _destination():
    base = os.environ.get('OPENXIAOAI_BASE_URL', 'http://127.0.0.1:9092').rstrip('/')
    scheme, host, port = _origin(base)
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == 'localhost'
    if local:
        # Dial the numeric loopback address directly.
        local_host = '127.0.0.1' if host == 'localhost' else (f'[{host}]' if ':' in host else host)
        return f'{scheme}://{local_host}:{port}', ''
    paired = os.environ.get('OPENXIAOAI_PAIRED_ORIGIN', '')
    if scheme != 'https' or not paired or _origin(paired) != (scheme, host, port):
        raise ValueError('远程请求需要匹配的 HTTPS OPENXIAOAI_PAIRED_ORIGIN')
    token = os.environ.get('OPENXIAOAI_REMOTE_TOKEN', '').strip()
    if not token:
        raise ValueError('配对服务缺少 OPENXIAOAI_REMOTE_TOKEN')
    authority = f'[{host}]' if ':' in host else host
    return f'{scheme}://{authority}:{port}', token


def api_request(path, method='GET', data=None, *, content_type='application/json', timeout=30):
    base, token = _destination()
    if not path.startswith('/api/'):
        raise ValueError('需要 /api/ 路径')
    headers = {'Content-Type': content_type}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with _open(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        hint = '：核对配对目标与 OPENXIAOAI_REMOTE_TOKEN' if exc.code == 401 else ''
        exc.close()
        raise RuntimeError(f'HTTP {exc.code}{hint}') from exc


def check_health():
    return api_request('/api/health')


def get_status():
    return api_request('/api/status')


def wakeup(silent=True):
    return api_request('/api/wakeup', method='POST', data={'silent': silent})


def interrupt():
    return api_request('/api/interrupt', method='POST')
