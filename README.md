# Movies

Your own private streaming site for the movies and TV shows you've downloaded.
It runs on your laptop; you watch in your phone's browser with nothing to download,
and it remembers where you stopped, so you can pause on the laptop and carry on from
the same spot on your phone.

- **Upload from the browser** (drag and drop, whole folders too) or copy files into a folder
- **Movies and TV shows**: episodes are grouped by show and season from their file names
  (`Show.Name.S01E02…`, `1x02`, `Season 1/…`)
- **Resume anywhere**: progress is saved on the server every few seconds and when you close the page,
  shared across all your devices
- **Continue watching** and **Up next**: finished an episode? The next one is waiting, and it
  starts playing by itself when an episode ends
- **Plays on iPhone and Android**: with [ffmpeg](#make-every-file-play-on-phones-ffmpeg) installed, MKV,
  AVI, AC3/DTS audio and other formats phones can't play are converted automatically in the background
- **Subtitles**: `.srt`/`.vtt` files next to your videos, subtitles inside MKV files, or add them from the app
- **Password protected**, with thumbnails, search, add-to-home-screen app mode, AirPlay/Chromecast and
  keyboard shortcuts
- No accounts, no cloud, no dependencies: one small Node.js app

---

## Quick start

1. **Install Node.js** (version 18 or newer) from <https://nodejs.org>. Pick the LTS version and click through the installer.
2. **Install ffmpeg** (optional, but recommended; see [below](#make-every-file-play-on-phones-ffmpeg)):
   - macOS: `brew install ffmpeg` (needs [Homebrew](https://brew.sh))
   - Windows: `winget install ffmpeg` in a terminal, then open a new terminal
   - Linux: `sudo apt install ffmpeg`
3. **Download this project** (green *Code* button → *Download ZIP*, then unzip it), or `git clone` it.
4. **Start it.** Open a terminal in the project folder and run:

   ```sh
   npm start
   ```

   (Windows: open the folder in File Explorer, type `cmd` in the address bar, press Enter, then run `npm start`.)
   You'll see something like:

   ```
     Movies is running

     On this computer:  http://localhost:8080
     On your phone:     http://192.168.1.23:8080
   ```

5. **Open <http://localhost:8080>** on the laptop and create a password.
6. **Open the "On your phone" address** on your phone (same Wi-Fi), or scan the QR code in
   **Settings**, and log in.

If your computer asks whether to allow incoming network connections for Node.js, click **Allow**.
Without that, your phone can't reach it. On Windows, allow it on **private networks**.

Stop the server with `Ctrl + C`. Nothing is lost: your library and progress are kept.

## Adding movies and shows

**From the browser:** go to **Upload**, drop in video files (or a whole season folder), check
the titles it guessed from the file names, and press **Upload**. Big files are sent in pieces, so
if the Wi-Fi drops the upload carries on from where it stopped. Put a subtitle file next to the
video (same name, `.srt`) and it's picked up too.

**By copying files** (faster for a big collection, on the computer running the server):

```
media/
├── movies/
│   ├── Inception (2010).mkv
│   └── The.Matrix.1999.1080p.BluRay.x264/       ← release folders are fine
│       ├── The.Matrix.1999.1080p.BluRay.x264.mp4
│       └── The.Matrix.1999.1080p.BluRay.x264.en.srt
└── tv/
    └── Breaking Bad/
        ├── Season 1/
        │   ├── Breaking.Bad.S01E01.Pilot.mkv
        │   └── Breaking.Bad.S01E02.mkv
        └── Season 2/ …
```

New files show up within a few minutes, or press **Settings → Rescan folder**. Files dropped
anywhere else in `media/` are sorted automatically: anything named like `S01E02` is a TV episode,
everything else is a movie. Titles can be fixed from the app (⋯ → *Edit*).

You can point the app at a folder you already have with `MEDIA_DIR`, e.g.
`MEDIA_DIR="/Users/you/Videos" npm start`.

## Watching on your phone

- Your phone needs to be on the **same Wi-Fi** as the laptop, and the laptop needs to be awake
  with the server running.
- Add it to your home screen so it opens full-screen like an app:
  - **iPhone** (Safari): Share button → *Add to Home Screen*
  - **Android** (Chrome): ⋮ → *Add to Home screen* / *Install app*
- In the player: tap **CC** for subtitles and **Next episode** to skip ahead. Rotate the phone and
  tap the fullscreen button in the video controls for the full picture.
- On the laptop: `Space` play/pause, `←`/`→` skip 10 s, `F` fullscreen, `M` mute, `C` subtitles,
  `N` next episode.

**Keep the laptop awake.** If it goes to sleep, playback stops. On a Mac you can run the server as
`caffeinate -i npm start` to prevent sleep while it's running. On Windows, set *Settings → System →
Power → Sleep* to *Never* while plugged in.

## Watching away from home

The phone addresses only work on your home network. To watch anywhere:

**Tailscale (recommended: free, private, nothing exposed to the internet)**

1. Install [Tailscale](https://tailscale.com/download) on the laptop and on your phone, and sign in
   with the same account on both.
2. Restart the server. It prints an extra address marked *(Tailscale)*, like `http://100.x.y.z:8080`.
   It's also listed in **Settings**.
3. Open that address on your phone. It works on mobile data or any Wi-Fi, as long as Tailscale is
   switched on.

**Cloudflare Tunnel (a public link, handy for a quick share)**

Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
and run this next to the server:

```sh
cloudflared tunnel --url http://localhost:8080
```

It prints an `https://….trycloudflare.com` address you can open from anywhere. Anyone with the
link sees the login page, so use a strong password. (For your own safety, the first password can't be
created through a tunnel. Set it up at home first.)

## Make every file play on phones (ffmpeg)

Browsers, especially on iPhone, only play some video formats. Most MP4 downloads play everywhere.
MKV files don't play on iPhones, and many downloads use AC3/DTS audio that plays with no sound in
Chrome.

When [ffmpeg](https://ffmpeg.org) is installed, the server checks every file and fixes the ones that
won't play, in the background:

| File | What happens | Speed |
| --- | --- | --- |
| MP4 with H.264/HEVC + AAC | Plays as is | nothing to do |
| MKV with H.264/HEVC video | Repackaged as MP4 (no quality loss) | ~1 minute per movie |
| AC3 / DTS / TrueHD / FLAC audio | Audio converted to AAC stereo | fast |
| AVI / XviD / DivX / WMV / 10-bit H.264 | Video re-encoded to H.264 (up to 1080p) | slow: roughly real time or faster |

The converted MP4 replaces the original file in the library folder (your download stays wherever
you uploaded it from), and your progress, subtitles and thumbnail carry over. Text subtitles inside
MKV files are extracted first so they aren't lost. Progress is shown on the video's page and in
**Settings**.

Without ffmpeg everything still works: MP4 files play everywhere, MKV usually plays in Chrome on Android
and desktop, and the app marks files that might not play.

## Settings

Set these as environment variables when starting, e.g. `PORT=9000 npm start`
(Windows: `set PORT=9000 && npm start`).

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `MEDIA_DIR` | `./media` | Where videos live (`movies/` and `tv/` inside it) |
| `DATA_DIR` | `./data` | Progress, thumbnails, subtitles and password |
| `MOVIES_PASSWORD` | – | Set the password here instead of on first visit |
| `AUTO_CONVERT` | `1` | `0` = only convert when you press *Convert for phones* |
| `FFMPEG` | `1` | `0` = never use ffmpeg, even if installed |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Custom ffmpeg location |
| `PUBLIC_URL` | – | The address to show for phones (useful in Docker) |
| `HOST` | `0.0.0.0` | Network interface to listen on |

## Running it on an always-on computer (Docker)

If you have a home server, NAS or old PC, you can run it there instead of on the laptop. With
[Docker](https://docs.docker.com/get-docker/):

```sh
docker compose up -d
```

This builds an image with ffmpeg included and keeps your files in `./media` and `./data`. Edit
`docker-compose.yml` to set `PUBLIC_URL` to that machine's address (e.g. `http://192.168.1.50:8080`).

## Your data

- Videos are ordinary files in `media/`. You can browse, back up or move them any time.
- Everything else is in `data/`: `library.json` (progress and edits), `thumbs/`, `posters/`,
  `subs/` and `auth.json` (your hashed password). Back up `data/` to keep your watch history.
- **Forgot your password?** Stop the server, delete `data/auth.json`, start it again and create a
  new one. Your library and progress are untouched.

## Troubleshooting

**The phone can't open the address.** Check that both are on the same Wi-Fi (not a guest
network, which usually blocks devices from seeing each other), that the server is still running, and
that you allowed Node.js through the firewall. On Windows, your Wi-Fi must be set to *Private network*.

**A video won't play, or plays with no sound.** Install ffmpeg and restart the server. It'll convert
the file. Its page shows the progress.

**Upload stopped halfway.** Press **Retry**; it continues where it stopped. If you closed the tab,
add the same file again and upload; it resumes too.

**Port 8080 is busy.** Start with another port: `PORT=8081 npm start`.

## Development

Plain Node.js (18+) with no dependencies and no build step. The server is in `lib/`, the web app
in `public/`.

```sh
npm test      # runs the test suite (the conversion test needs ffmpeg, and is skipped otherwise)
```
