import { spawn } from 'node:child_process';
import { language } from './languages.js';

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const CODEC_NAMES = {
  h264: 'H.264', hevc: 'HEVC', mpeg4: 'MPEG-4 (XviD/DivX)', msmpeg4v3: 'DivX', mpeg2video: 'MPEG-2',
  vc1: 'VC-1', wmv3: 'WMV', ac3: 'Dolby Digital (AC3)', eac3: 'Dolby Digital Plus', dts: 'DTS',
  truehd: 'Dolby TrueHD', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', pcm_s16le: 'PCM', vp8: 'VP8', vp9: 'VP9', av1: 'AV1',
};
const codecName = (c) => CODEC_NAMES[c] ?? String(c).toUpperCase();

function run(cmd, args, { signal, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (onStdout ? onStdout(String(d)) : (stdout += d)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code === 0) return resolve({ stdout, stderr });
      const lastLine = stderr.trim().split('\n').pop() || `exit code ${code}`;
      reject(new Error(`${cmd} failed: ${lastLine}`));
    });
  });
}

/**
 * Decides whether a file plays as-is in phone and desktop browsers, and if not, the
 * cheapest ffmpeg recipe that fixes it (usually a lossless remux into MP4).
 */
export function planFor(info, ext) {
  const v = info.video;
  const a = info.audio;
  const container = ['mp4', 'm4v', 'mov'].includes(ext) ? 'mp4' : ext === 'webm' ? 'webm' : 'other';

  const h264Ok = v?.codec === 'h264' && !/10|4:2:2|4:4:4/.test(v.profile || '') && /^yuvj?420p$/.test(v.pixFmt || 'yuv420p');
  // What can go into an MP4 untouched and still play in phone browsers.
  const videoCopyable = !v || h264Ok || ['hevc', 'av1', 'vp9'].includes(v.codec);
  const audioCopyable = !a || ['aac', 'mp3'].includes(a.codec);

  const reasons = [];
  if (container === 'webm') {
    if (v && !['vp8', 'vp9', 'av1'].includes(v.codec)) reasons.push(`${codecName(v.codec)} video in a WebM file won't play in browsers`);
    if (a && !['opus', 'vorbis'].includes(a.codec)) reasons.push(`${codecName(a.codec)} audio in a WebM file won't play in browsers`);
  } else {
    if (container === 'other') reasons.push(`${ext.toUpperCase()} files don't play in most phone browsers`);
    if (!videoCopyable) reasons.push(`${codecName(v.codec)}${v.codec === 'h264' ? ' 10-bit' : ''} video isn't supported by browsers`);
    if (!audioCopyable) reasons.push(`${codecName(a.codec)} audio won't play in most browsers`);
    if (container === 'mp4' && v?.codec === 'hevc' && v.tag !== 'hvc1') reasons.push('HEVC video needs re-tagging for iPhone');
  }

  return {
    playable: reasons.length === 0,
    reason: reasons.join('; '),
    video: videoCopyable ? 'copy' : 'transcode',
    videoIndex: v?.index ?? null,
    hevc: v?.codec === 'hevc',
    audio: !a ? null : audioCopyable ? 'copy' : 'transcode',
    audioIndex: a?.index ?? null,
  };
}

export class Media {
  constructor({ enabled, ffmpegPath, ffprobePath }) {
    this.enabled = enabled;
    this.ffmpeg = ffmpegPath;
    this.ffprobe = ffprobePath;
    this.available = false;
  }

  async detect() {
    if (!this.enabled) return false;
    try {
      await run(this.ffmpeg, ['-version']);
      await run(this.ffprobe, ['-version']);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async probe(file) {
    const { stdout } = await run(this.ffprobe, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ]);
    const data = JSON.parse(stdout);
    const streams = data.streams || [];
    const videoStream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
    const audioStream = audioStreams.find((s) => s.disposition?.default) ?? audioStreams[0];
    const duration = Number(data.format?.duration) || Number(videoStream?.duration) || null;
    return {
      duration,
      video: videoStream && {
        index: videoStream.index,
        codec: videoStream.codec_name,
        profile: videoStream.profile,
        pixFmt: videoStream.pix_fmt,
        tag: videoStream.codec_tag_string,
        width: videoStream.width,
        height: videoStream.height,
      },
      audio: audioStream && { index: audioStream.index, codec: audioStream.codec_name, channels: audioStream.channels },
      textSubtitles: streams
        .filter((s) => s.codec_type === 'subtitle' && TEXT_SUBTITLE_CODECS.has(s.codec_name))
        .map((s, n) => {
          const lang = language(s.tags?.language);
          const title = s.tags?.title?.trim();
          let label = title || lang?.name || `Track ${n + 1}`;
          if (s.disposition?.forced && !/forced/i.test(label)) label += ' (forced)';
          return { index: s.index, lang: lang?.lang ?? '', label };
        }),
    };
  }

  thumbnail(src, dest, { at, videoIndex }) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(at), '-i', src];
    if (videoIndex != null) args.push('-map', `0:${videoIndex}`);
    args.push('-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', dest);
    return run(this.ffmpeg, args);
  }

  /** Writes each embedded text subtitle track to its own WebVTT file in one pass. */
  extractSubtitles(src, tracks, signal) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src];
    for (const t of tracks) args.push('-map', `0:${t.index}`, '-f', 'webvtt', t.dest);
    return run(this.ffmpeg, args, { signal });
  }

  /** Remuxes (or, when unavoidable, transcodes) into a phone-friendly MP4. */
  convert(src, dest, plan, { duration, onProgress, signal }) {
    const args = ['-hide_banner', '-nostdin', '-y', '-i', src];
    args.push('-map', plan.videoIndex != null ? `0:${plan.videoIndex}` : '0:v:0?');
    if (plan.audio) args.push('-map', `0:${plan.audioIndex}`);
    if (plan.video === 'copy') {
      args.push('-c:v', 'copy');
      if (plan.hevc) args.push('-tag:v', 'hvc1');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
    }
    if (plan.audio === 'copy') args.push('-c:a', 'copy');
    else if (plan.audio === 'transcode') args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    args.push(
      '-sn', '-dn', '-map_chapters', '-1', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '4096',
      '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', dest,
    );
    let buffer = '';
    return run(this.ffmpeg, args, {
      signal,
      onStdout: (text) => {
        buffer += text;
        const matches = [...buffer.matchAll(/out_time_us=(\d+)/g)];
        if (matches.length && duration) onProgress?.(Math.min(0.99, Number(matches.at(-1)[1]) / 1e6 / duration));
        buffer = buffer.slice(-200);
      },
    });
  }
}
