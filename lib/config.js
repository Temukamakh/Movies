import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const flag = (value, fallback) =>
  value == null || value === '' ? fallback : !/^(0|false|no|off)$/i.test(String(value));

/** Settings come from environment variables; tests pass overrides directly. */
export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    port: Number(overrides.port ?? env.PORT ?? 8080),
    host: overrides.host ?? env.HOST ?? '0.0.0.0',
    mediaDir: path.resolve(overrides.mediaDir ?? env.MEDIA_DIR ?? path.join(ROOT, 'media')),
    dataDir: path.resolve(overrides.dataDir ?? env.DATA_DIR ?? path.join(ROOT, 'data')),
    publicDir: path.join(ROOT, 'public'),
    password: overrides.password ?? (env.MOVIES_PASSWORD || null),
    useFfmpeg: overrides.useFfmpeg ?? flag(env.FFMPEG, true),
    ffmpegPath: overrides.ffmpegPath ?? (env.FFMPEG_PATH || 'ffmpeg'),
    ffprobePath: overrides.ffprobePath ?? (env.FFPROBE_PATH || 'ffprobe'),
    autoConvert: overrides.autoConvert ?? flag(env.AUTO_CONVERT, true),
    // Shown as the "open on your phone" address; needed in Docker, which can't see the host's Wi-Fi IP.
    publicUrl: overrides.publicUrl ?? (env.PUBLIC_URL?.replace(/\/+$/, '') || null),
    quiet: overrides.quiet ?? false,
  };
}
