use crate::python::PythonManager;
use open_xiaoai::base::{AppError, VERSION};
use open_xiaoai::services::audio::config::AudioConfig;
use open_xiaoai::services::connect::data::{Event, Request, Response, Stream};
use open_xiaoai::services::connect::handler::MessageHandler;
use open_xiaoai::services::connect::message::{MessageManager, WsStream};
use open_xiaoai::services::connect::rpc::RPC;
use open_xiaoai::services::speaker::SpeakerManager;
use open_xiaoai::utils::task::TaskManager;
use pyo3::types::PyBytes;
use pyo3::types::PyString;
use pyo3::Python;
use serde_json::json;
use std::env;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, accept_hdr_async};

pub struct AppServer;

/// Check if audio input is enabled via environment variable.
/// Supports: "true"/"false", "1"/"0", "yes"/"no", etc.
/// Defaults to true if not set or invalid.
fn is_audio_input_enabled() -> bool {
    match env::var("AUDIO_INPUT_ENABLE") {
        Ok(val) => {
            let val = val.trim().to_lowercase();
            matches!(val.as_str(), "true" | "1" | "yes" | "on")
        }
        Err(_) => true,
    }
}

/// Check if the connect prompt should be skipped, so the speaker stays quiet
/// while the bridge comes up (the plugin exposes this as "静默启动").
/// Supports: "true"/"false", "1"/"0", "yes"/"no", etc.
/// Defaults to false if not set or invalid, keeping the upstream prompt.
fn is_silent_start() -> bool {
    match env::var("SILENT_START_ENABLE") {
        Ok(val) => {
            let val = val.trim().to_lowercase();
            matches!(val.as_str(), "true" | "1" | "yes" | "on")
        }
        Err(_) => false,
    }
}

/// Token the speaker must present to be served, from `DSH_XIAOAI_TOKEN`.
///
/// The plugin hands the same value down that the API Server uses; empty means
/// the plugin did not provide one and the handshake is not checked.
fn expected_token() -> String {
    env::var("DSH_XIAOAI_TOKEN").unwrap_or_default()
}

/// Percent-decode one query value. `+` is left alone: tokens are compared raw.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pull `token` out of a request URI's query string (`/?token=...`).
///
/// The stock open-xiaoai client sends no headers at all — the coderzc fork can
/// be told to with `OPEN_XIAOAI_TOKEN`, but the binary most speakers run cannot.
/// Accepting the token in the dial URL lets those devices opt in by editing
/// `/data/open-xiaoai/server.txt` alone, with no re-flash.
fn query_token(query: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            if key == "token" {
                return Some(percent_decode(value));
            }
        }
    }
    None
}

/// Compare two tokens without a data-dependent early exit: every byte of the
/// common length is always folded in, so a wrong guess leaks no timing about
/// *where* it first differs. A length mismatch still returns immediately -- the
/// lengths are fixed token strings, not secret material.
fn tokens_match(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

async fn test() -> Result<(), AppError> {
    if !is_silent_start() {
        SpeakerManager::play_text("已连接").await?;
    }

    // Only start recording if audio input is enabled
    if is_audio_input_enabled() {
        let _ = RPC::instance()
            .call_remote(
                "start_recording",
                Some(json!(AudioConfig {
                    pcm: "noop".into(),
                    channels: 1,
                    bits_per_sample: 16,
                    sample_rate: 16000,
                    period_size: 1440 / 4,
                    buffer_size: 1440,
                })),
                None,
            )
            .await;
    }

    // aplay is started lazily by ensure_player_ready() on first audio send,
    // avoiding empty-buffer underruns from idling aplay processes.

    Ok(())
}

impl AppServer {
    pub async fn connect(stream: TcpStream) -> Result<WsStream, AppError> {
        let expected = expected_token();
        if !expected.is_empty() {
            use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
            let ws_stream = accept_hdr_async(stream, move |req: &Request, response: Response| {
                // Either a `Bearer` header (the fork's client, or any other
                // client that can set one) or `?token=` in the dial URL, which
                // the stock client passes through untouched from server.txt.
                let header = req
                    .headers()
                    .get("Authorization")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
                    // A `Bearer ` with an empty value must not shadow a valid
                    // `?token=`: `or_else` below is only evaluated while this is
                    // `None`, and an empty value can never match a non-empty
                    // expected token anyway.
                    .filter(|value| !value.is_empty());
                let presented = header
                    .map(str::to_string)
                    .or_else(|| req.uri().query().and_then(query_token));
                if presented.as_deref().map(|value| tokens_match(value, &expected)) != Some(true) {
                    let error: ErrorResponse = tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(401)
                        .body(Some("Unauthorized".to_string()))
                        .unwrap();
                    return Err(error);
                }
                Ok(response)
            })
            .await?;
            Ok(WsStream::Server(ws_stream))
        } else {
            let ws_stream = accept_async(stream).await?;
            Ok(WsStream::Server(ws_stream))
        }
    }

    pub async fn run() {
        let addr = "0.0.0.0:4399";
        let listener = TcpListener::bind(&addr)
            .await
            .expect(format!("[AppServer] ❌ 绑定地址失败: {}", &addr).as_str());
        crate::pylog!("[AppServer] ✅ 已启动: {:?}", addr);
        if expected_token().is_empty() {
            crate::pylog!(
                "[AppServer] ⚠️ DSH_XIAOAI_TOKEN 为空，4399 的握手不做鉴权（设置里「音箱连接鉴权」关闭，或拿不到访问令牌）；\
如需鉴权请打开该开关或给插件配一枚令牌。"
            );
        }
        // A failing accept (a full descriptor table is the realistic one) used to
        // end the loop for good and leave 4399 dead until the next restart. Retry
        // forever, but back off while it keeps failing: ten attempts per second
        // would otherwise write ten log lines per second for the rest of the run.
        let mut failures: u32 = 0;
        loop {
            match listener.accept().await {
                // 同一时刻只处理一个连接
                Ok((stream, addr)) => {
                    failures = 0;
                    AppServer::handle_connection(stream, addr).await
                }
                Err(e) => {
                    let delay_ms = 100u64.saturating_mul(1u64 << failures.min(6));
                    crate::pylog!(
                        "[AppServer] ❌ 接受连接失败: {}（{} 毫秒后继续监听）",
                        e,
                        delay_ms
                    );
                    failures = failures.saturating_add(1);
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }

    async fn handle_connection(stream: TcpStream, addr: std::net::SocketAddr) {
        let ws_stream = match AppServer::connect(stream).await {
            Ok(ws_stream) => ws_stream,
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("401") || msg.contains("Unauthorized") {
                    crate::pylog!(
                        "[AppServer] ❌ 鉴权失败: {}（音箱要带上与「访问令牌凭据名」相同的令牌：\
支持令牌的客户端在设备上加 OPEN_XIAOAI_TOKEN，其它客户端把 /data/open-xiaoai/server.txt \
写成 ws://<电脑IP>:4399?token=<令牌>；不要这层就在设置里关掉「音箱连接鉴权」）",
                        addr
                    );
                } else {
                    crate::pylog!("[AppServer] ❌ 连接异常: {} ({})", addr, msg);
                }
                return;
            }
        };
        crate::pylog!("[AppServer] ✅ 已连接: {:?}", addr);
        AppServer::init(ws_stream).await;
        if let Err(e) = MessageManager::instance().process_messages().await {
            crate::pylog!("[AppServer] ❌ 消息处理异常: {}", e);
        }
        AppServer::dispose().await;
        crate::pylog!("[AppServer] ❌ 已断开连接");
    }

    async fn init(ws_stream: WsStream) {
        MessageManager::instance().init(ws_stream).await;
        MessageHandler::<Event>::instance()
            .set_handler(on_event)
            .await;
        MessageHandler::<Stream>::instance()
            .set_handler(on_stream)
            .await;

        let rpc = RPC::instance();
        rpc.add_command("get_version", get_version).await;

        let test = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let _ = test().await;
        });
        TaskManager::instance().add("test", test).await;
    }

    async fn dispose() {
        MessageManager::instance().dispose().await;
        TaskManager::instance().dispose("test").await;
    }
}

async fn get_version(_: Request) -> Result<Response, AppError> {
    let data = json!(VERSION.to_string());
    Ok(Response::from_data(data))
}

async fn on_stream(stream: Stream) -> Result<(), AppError> {
    let Stream { tag, bytes, .. } = stream;
    match tag.as_str() {
        "record" => {
            let data = Python::with_gil(|py| PyBytes::new(py, &bytes).into());
            PythonManager::instance().call_fn("on_input_data", Some(data))?;
        }
        _ => {}
    }
    Ok(())
}

async fn on_event(event: Event) -> Result<(), AppError> {
    let event_json = serde_json::to_string(&event)?;
    let data = Python::with_gil(|py| PyString::new(py, &event_json).into());
    PythonManager::instance().call_fn("on_event", Some(data))?;
    Ok(())
}
