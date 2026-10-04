use std::io;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream, ReadOnlySource};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Map TTS API format string to file extension hint for symphonia probe.
fn format_to_extension(format: &str) -> &str {
    match format {
        "mp3" => "mp3",
        "ogg" | "ogg_opus" | "ogg_vorbis" => "ogg",
        "wav" => "wav",
        "flac" => "flac",
        "pcm" => "wav", // raw PCM treated as wav
        _ => format,    // fallback: use as-is
    }
}

/// Decode audio bytes into PCM (16-bit signed, mono).
/// Supports any format that symphonia can probe: MP3, OGG Vorbis, WAV, FLAC, etc.
/// Frame alignment is handled by symphonia's format reader.
pub fn decode_audio_to_pcm(
    audio_data: &[u8],
    format: &str,
    target_sample_rate: u32,
) -> Result<Vec<u8>, String> {
    if format == "pcm" {
        return Ok(audio_data.to_vec());
    }

    let cursor = io::Cursor::new(audio_data.to_vec());
    let source: Box<dyn MediaSource> = Box::new(ReadOnlySource::new(cursor));
    let mss = MediaSourceStream::new(source, Default::default());

    let mut hint = Hint::new();
    hint.with_extension(format_to_extension(format));

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Probe failed (format={}): {}", format, e))?;

    let mut reader = probed.format;

    // Find the first audio track
    let track = reader
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track found")?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Decoder creation failed: {}", e))?;

    let source_sample_rate = codec_params.sample_rate.unwrap_or(24000);
    let channels = codec_params.channels.map(|c| c.count()).unwrap_or(1);

    let mut all_samples: Vec<i16> = Vec::new();

    loop {
        let packet = match reader.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue, // Skip corrupt frames
        };

        let spec = *decoded.spec();
        let num_frames = decoded.capacity();
        let mut sample_buf = SampleBuffer::<i16>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        let samples = sample_buf.samples();

        if channels > 1 {
            // Mix down to mono
            for chunk in samples.chunks(channels) {
                let sum: i32 = chunk.iter().map(|&s| s as i32).sum();
                all_samples.push((sum / channels as i32) as i16);
            }
        } else {
            all_samples.extend_from_slice(samples);
        }
    }

    // Resample if needed
    let final_samples = if source_sample_rate != target_sample_rate {
        resample(&all_samples, source_sample_rate, target_sample_rate)
    } else {
        all_samples
    };

    // Convert i16 samples to bytes (little-endian)
    let mut pcm_bytes = Vec::with_capacity(final_samples.len() * 2);
    for sample in &final_samples {
        pcm_bytes.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(pcm_bytes)
}

/// Simple linear interpolation resampler
fn resample(samples: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let output_len = (samples.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;

        if idx + 1 < samples.len() {
            let s = samples[idx] as f64 * (1.0 - frac) + samples[idx + 1] as f64 * frac;
            output.push(s.round() as i16);
        } else if idx < samples.len() {
            output.push(samples[idx]);
        }
    }

    output
}

/// Streaming audio decoder that accumulates encoded data and decodes in chunks.
/// Supports any format that symphonia can handle (MP3, OGG Vorbis, WAV, etc.).
pub struct StreamingDecoder {
    buffer: Vec<u8>,
    format: String,
    target_sample_rate: u32,
    emitted_pcm_bytes: usize,
}

impl StreamingDecoder {
    pub fn new(format: &str, target_sample_rate: u32) -> Self {
        Self {
            buffer: Vec::new(),
            format: format.to_string(),
            target_sample_rate,
            emitted_pcm_bytes: 0,
        }
    }

    /// Feed encoded audio data into the buffer.
    pub fn feed(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Decode all accumulated audio data and return only the newly available PCM.
    ///
    /// The decode is CPU-bound and synchronous (the whole accumulated buffer is
    /// re-decoded on every call), so it is moved onto the blocking thread pool:
    /// running it inline would stall this task's Tokio worker and delay the
    /// fetch/playback tasks it shares the runtime with. The accumulated buffer is
    /// moved into the blocking task and moved back afterwards, so the decoder
    /// keeps its state and the already-emitted prefix is still dropped below.
    pub async fn decode_all(&mut self) -> Result<Vec<u8>, String> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }

        // Shared, not moved: a panicking blocking task unwinds its closure and
        // takes everything the closure owned with it, so a plain `Vec` moved in
        // would leave the decoder with an empty buffer while `emitted_pcm_bytes`
        // still claimed a full prefix had been emitted -- the rest of that stream
        // would then be dropped silently by the `pcm.len() <= emitted` check.
        let buffer = std::sync::Arc::new(std::mem::take(&mut self.buffer));
        let format = self.format.clone();
        let target_sample_rate = self.target_sample_rate;
        let emitted_pcm_bytes = self.emitted_pcm_bytes;

        let decoded = tokio::task::spawn_blocking({
            let buffer = std::sync::Arc::clone(&buffer);
            move || decode_audio_to_pcm(&buffer[..], &format, target_sample_rate)
        })
        .await;

        // The task (and with it the only other handle) is gone either way by now,
        // so this normally unwraps; falling back to a copy keeps the data rather
        // than pretending it was never there.
        self.buffer = std::sync::Arc::try_unwrap(buffer).unwrap_or_else(|shared| (*shared).clone());

        let pcm = match decoded {
            Ok(pcm) => pcm?,
            Err(err) => return Err(format!("decode task failed: {}", err)),
        };
        if pcm.len() <= emitted_pcm_bytes {
            return Ok(Vec::new());
        }

        let new_pcm = pcm[emitted_pcm_bytes..].to_vec();
        self.emitted_pcm_bytes = pcm.len();
        Ok(new_pcm)
    }
}
