# Video Slicer
n**Live demo:** https://sm079.github.io/video-slicer/

Cut a video into frame-exact clips in the browser. Pick an output frame rate, draw windows on any number of tracks, give each window a crop (rotated and keyframed if you like), and export every window as its own MP4, WebM or PNG sequence, with the audio under it. Nothing is uploaded: decoding, rendering and encoding all run locally in the tab.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm test         # unit tests (Node 23.6+)
```

Use a current Chromium browser (Chrome, Edge, Opera). Exporting to a folder needs the File System Access API, which only Chromium has; any browser can export a ZIP or download the files one by one.

## Workflow

1. **Open** or drop a video. MP4, MOV, MKV, WebM and MPEG-TS are read natively; AVI, FLV, WMV and other containers go through an ffmpeg (libavformat) demuxer compiled to WebAssembly. The codec must be one the browser can decode (H.264, HEVC where supported, VP8/9, AV1).
2. **Output fps** (Project tab). Blank means native: output frame *i* is source frame *i*, even for variable frame rate. A value conforms the video: output frame *i* covers [*i*/fps, (*i*+1)/fps) and shows the source frame on screen at the middle of that interval. These are the same frames `ffmpeg -vf fps=N` picks. Every frame number on the timeline is an output frame.
3. **Windows.** Drag on an empty track to draw one; double-click or press <kbd>N</kbd> for a default-length window at that spot. Drag a window to slide it, or drag up or down to move it to another track. Drag its edges to resize. Windows on one track never overlap; a new window that doesn't fit goes to the next free track, or to a new one.
4. **Length rule** (Track tab). Each track can require lengths of the form *a·n + b* (presets for 4n+1, 8n+1 and so on; *a* = 1 allows any length). Creating, resizing and typing lengths all snap to it.
5. **Loop.** Click ▶ on a window, or press <kbd>L</kbd>, to loop it. Short windows stay fully cached and loop without re-decoding. Looping a combined window plays its whole group in order.
6. **Crop.** Drag the box to move it, the handles to resize, and the round handle to rotate. Drag outside the box to draw a new one. A track's output size can be derived from the crop (sides snapped to a multiple of ÷), or fixed with W × H, which locks the crop's shape. Number fields can be dragged by their labels to scrub the value. Turn on **Keyframes** to animate the crop: every edit then keys it at the playhead, and keys interpolate linearly.
7. **Combine.** <kbd>Ctrl</kbd>- or <kbd>Shift</kbd>-click windows to select several, then press <kbd>G</kbd> (or **Combine** in the Window tab) to join them into one clip that plays and exports in the order you picked them. Windows can be combined across tracks and need not touch; each window belongs to at most one group, and <kbd>Shift</kbd>+<kbd>G</kbd> splits a group up again. With five windows, combining 5 and 1, then 2 and 4, exports three files: 5→1, 2→4 and 3. On the timeline, combined windows are labelled with their group and place in it (`G1·2`).
8. **Export** (<kbd>Ctrl</kbd>+<kbd>E</kbd>) writes one file per window plus an optional `manifest.json` with each clip's range, source frames, size and crop keys. Save to a folder, a ZIP, or as separate downloads (PNG frames then come out flat, as `clip_00000.png`). A combined group exports as one file: it takes the first window's output size, the others are trimmed to its shape and scaled, and the manifest lists its parts under `segments`. Exporting any window of a group exports the whole group.
9. **Audio** plays along with playback and loops (<kbd>M</kbd> mutes; the volume sits in the transport bar). Exports carry the source audio from each clip's first frame for exactly the clip's duration: AAC in MP4 (Opus if the browser has no AAC encoder), Opus in WebM, and `audio.wav` beside PNG frames. Audio is resampled to 48 kHz only when the encoder can't take the source rate, and mixed down to stereo.

Hover any control for its name and shortcut, or press <kbd>?</kbd> for the full list. The menu switches between light, dark and the system theme.

The editor state (windows, tracks, fps, playhead, selection and timeline zoom) autosaves in the browser under a fingerprint of the video's content, so opening the same video again, even renamed or copied elsewhere, picks up where you left off. **Start over** in the menu clears the video's project (undoable), and **Save project** writes it to JSON. The fingerprint is a SHA-256 of the whole file up to 64 MB; for larger files it covers the size and 32 evenly spaced 1 MiB samples, so opening stays fast.

## How it stays frame-exact

- **Index.** On open, every packet's timestamp is read without decoding. For MP4/MOV this comes from the sample table, so a two-hour file opens in under a second. Frames are addressed by index, never by approximate time.
- **Decoding.** WebCodecs decodes in hardware. One decode session runs from the needed keyframe; anything wanted ahead of it in the same or next GOP comes from that session, so stepping, playback and looping never re-decode. Frames are cached as full-resolution bitmaps within a configurable budget (Project tab → Frame cache, default 1 GB).
- **One render path.** The Output panel and the exporter call the same render function on frames copied the same way, so the preview is the encoded frame.
- **Color.** Untagged video is decoded with the BT.601 matrix, as ffmpeg, PyAV and OpenCV do. This can be switched to BT.709. Exports are tagged BT.709.

## Limits

- Playback audio follows the picture: it is restarted at the playhead when it drifts more than 0.1 s away, so a stall while 4K frames decode is heard as a short skip.
- Encoder delay the container can't signal stays in the audio, as it does in ffmpeg (for example the ~25 ms an MP3 in AVI starts late). WebM clips start about 7 ms late from Opus pre-skip.
- At 4K a 1 GB cache holds about 30 frames. Playback stays real-time, but loops longer than that decode while they play. A random seek costs a decode from the previous keyframe (about 0.3 s for a 2-second GOP at 4K).
- Containers on the ffmpeg path (AVI, FLV, …) have no sample table, so the first open reads through the whole file to build the index.
- MP4 export uses H.264, which needs even output sides (÷ of 2 or more).
