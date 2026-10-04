use open_xiaoai::services::audio::config::AudioConfig;
use open_xiaoai::services::connect::message::MessageManager;
use open_xiaoai::services::connect::rpc::RPC;
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use serde_json::json;
use server::AppServer;
use std::sync::atomic::{AtomicU8, Ordering};

pub mod macros;
pub mod opus;
pub mod python;
pub mod server;
pub mod tts;

/// The remote aplay is not known to be running; the next frame starts it.
pub(crate) const PLAYER_IDLE: u8 = 0;
/// A `start_play` RPC is in flight; other frames must not send a second one.
pub(crate) const PLAYER_STARTING: u8 = 1;
/// The device accepted `start_play`; frames can be sent without another RPC.
pub(crate) const PLAYER_READY: u8 = 2;

/// Tracks whether the remote aplay process is known to be freshly started.
///
/// Three states, not a bool: the old code flipped a bool to "ready" *before*
/// the RPC that actually starts aplay and dropped its result, so one failed
/// `start_play` (device busy, socket gone) left the flag claiming a player that
/// was never started -- every later frame was streamed into nothing and no
/// caller ever retried until someone called `stop_playing`. Ready now means the
/// device answered; a failed start falls back to idle so the next frame tries
/// again. `tts::ensure_player_started` resets it the same way `stop_playing`
/// does.
pub(crate) static PLAYER_STATE: AtomicU8 = AtomicU8::new(PLAYER_IDLE);

/// Default playback AudioConfig (24kHz, 200ms buffer).
fn playback_config() -> AudioConfig {
    AudioConfig {
        pcm: "noop".into(),
        channels: 1,
        bits_per_sample: 16,
        sample_rate: 24000,
        period_size: 1200,
        buffer_size: 4800,
    }
}

/// Hands the "starting" latch back to idle if the `start_play` round trip never
/// finishes.
///
/// `ensure_player_ready` awaits a Python-visible future: pyo3-async-runtimes
/// drops the Rust future when the caller's `asyncio.Task` is cancelled, and a
/// future dropped after it claimed `PLAYER_STARTING` would otherwise leave the
/// player permanently "starting" -- every later frame skips the RPC and stays
/// silently muted, with nothing in the log. Returning the latch on drop can cost
/// one redundant `start_play` at worst; it can never hand the latch to two
/// callers, because only the owner of `PLAYER_STARTING` can release it.
struct PlayerStartGuard {
    armed: bool,
}

impl PlayerStartGuard {
    fn new() -> Self {
        Self { armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PlayerStartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = PLAYER_STATE.compare_exchange(
                PLAYER_STARTING,
                PLAYER_IDLE,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
    }
}

/// Ensure the remote aplay is freshly started. Skips the RPC if already ready.
pub async fn ensure_player_ready() {
    // Only an idle latch wins the right to send the RPC. "Ready" and "starting"
    // both mean somebody already has this covered, which is what the old bool's
    // swap did -- but a refused RPC now returns the latch to idle instead of
    // leaving it stuck at ready.
    if PLAYER_STATE
        .compare_exchange(
            PLAYER_IDLE,
            PLAYER_STARTING,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_err()
    {
        return;
    }
    let mut guard = PlayerStartGuard::new();
    match RPC::instance()
        .call_remote("start_play", Some(json!(playback_config())), None)
        .await
    {
        Ok(_) => {
            // Only the call that still owns `PLAYER_STARTING` may claim ready.
            // An unconditional store here would race `stop_playing` (or the
            // reset `ensure_player_started` performs): a stop landing while the
            // RPC is in flight has already sent `stop_play`, so storing ready
            // afterwards leaves every later frame streaming into a player that
            // was told to stop -- silent until the next explicit restart.
            guard.disarm();
            match PLAYER_STATE.compare_exchange(
                PLAYER_STARTING,
                PLAYER_READY,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {}
                // Another start claimed it while this one was in flight; ready
                // is the state we wanted anyway, so stay quiet.
                Err(PLAYER_READY) => {}
                Err(_) => {
                    crate::pylog!(
                        "[Audio] ⚠️ start_play 返回前播放已被停止，这次就绪状态作废（下一次播放会重新启动）"
                    );
                }
            }
        }
        Err(e) => {
            // The guard already returned the latch to idle on the way out.
            crate::pylog!(
                "[Audio] ❌ 启动远端播放器失败: {}（下一次播放会重试）",
                e
            );
        }
    }
}

#[pyfunction]
fn on_output_data(py: Python, data: Py<PyBytes>) -> PyResult<Bound<PyAny>> {
    let bytes = data.as_bytes(py).to_vec();
    pyo3_async_runtimes::tokio::future_into_py(py, async move {
        ensure_player_ready().await;
        let _ = MessageManager::instance()
            .send_stream("play", bytes, None)
            .await;
        Ok(())
    })
}

#[pyfunction]
fn start_server(py: Python) -> PyResult<Bound<PyAny>> {
    pyo3_async_runtimes::tokio::future_into_py(py, async {
        AppServer::run().await;
        Ok(())
    })
}

#[pyfunction]
fn run_shell(py: Python, script: String, timeout_millis: f64) -> PyResult<Bound<PyAny>> {
    pyo3_async_runtimes::tokio::future_into_py(py, async move {
        let res = RPC::instance()
            .call_remote(
                "run_shell",
                Some(json!(script)),
                Some(timeout_millis as u64),
            )
            .await;
        let result = match res {
            Err(e) => format!("run_shell error: {}", e),
            Ok(res) => serde_json::to_string(&res.data.unwrap()).unwrap(),
        };
        Ok(result)
    })
}

/// Stop the remote aplay process (interrupts PCM audio playback immediately).
#[pyfunction]
fn stop_playing(py: Python) -> PyResult<Bound<PyAny>> {
    PLAYER_STATE.store(PLAYER_IDLE, Ordering::SeqCst);
    pyo3_async_runtimes::tokio::future_into_py(py, async {
        let _ = RPC::instance()
            .call_remote("stop_play", None, None)
            .await;
        Ok(())
    })
}

/// Restart the remote aplay process for audio playback.
#[pyfunction]
fn start_playing(py: Python) -> PyResult<Bound<PyAny>> {
    PLAYER_STATE.store(PLAYER_IDLE, Ordering::SeqCst);
    pyo3_async_runtimes::tokio::future_into_py(py, async {
        ensure_player_ready().await;
        Ok(())
    })
}

/// Stop the remote arecord process (mutes the microphone).
#[pyfunction]
fn stop_recording(py: Python) -> PyResult<Bound<PyAny>> {
    pyo3_async_runtimes::tokio::future_into_py(py, async {
        let _ = RPC::instance()
            .call_remote("stop_recording", None, None)
            .await;
        Ok(())
    })
}

/// Restart the remote arecord process (unmutes the microphone).
#[pyfunction]
fn start_recording(py: Python) -> PyResult<Bound<PyAny>> {
    pyo3_async_runtimes::tokio::future_into_py(py, async {
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
        Ok(())
    })
}



#[pymodule]
fn dsh_xiaoai_server(_py: Python, m: Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(start_server, &m)?)?;
    m.add_function(wrap_pyfunction!(on_output_data, &m)?)?;
    m.add_function(wrap_pyfunction!(run_shell, &m)?)?;
    m.add_function(wrap_pyfunction!(stop_playing, &m)?)?;
    m.add_function(wrap_pyfunction!(start_playing, &m)?)?;
    m.add_function(wrap_pyfunction!(stop_recording, &m)?)?;
    m.add_function(wrap_pyfunction!(start_recording, &m)?)?;
    crate::opus::init_module(&m)?;
    crate::python::init_module(&m)?;
    crate::tts::init_module(&m)?;
    Ok(())
}
