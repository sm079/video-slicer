# Video Slicer

Cut a video into frame-exact clips in the browser. Pick an output frame rate, draw windows on any number of tracks, give each window a crop (rotated and keyframed if you like), and export every window as its own MP4, WebM or PNG sequence. Nothing is uploaded: decoding, rendering and encoding all run locally in the tab.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm test         # unit tests (Node 23.6+)
```

Use a current Chromium browser (Chrome, Edge, Opera). Exporting to a folder needs the File System Access API, which only Chromium has; other browsers get a ZIP download.

## Workflow

1. **Open** or drop a video. MP4, MOV, MKV, WebM and MPEG-TS are read natively; AVI, FLV, WMV and other containers go through an ffmpeg (libavformat) demuxer compiled to WebAssembly. The codec must be one the browser can decode (H.264, HEVC where supported, VP8/9, AV1).
2. **Output fps.** Blank means native: output frame *i* is source frame *i*, even for variable frame rate. A value conforms the video: output frame *i* covers [*i*/fps, (*i*+1)/fps) and shows the source frame on screen at the middle of that interval. These are the same frames `ffmpeg -vf fps=N` picks. Every frame number on the timeline is an output frame.
3. **Windows.** Drag on an empty track to draw one; double-click or press <kbd>N</kbd> for a default-length window at that spot. Drag a window to slide it, or drag up or down to move it to another track. Drag its edges to resize. Windows on one track never overlap; a new window that doesn't fit goes to the next free track, or to a new one.
4. **Length rule.** Each track can require lengths of the form *a·n + b* (presets for 4n+1, 8n+1 and so on; *a* = 1 allows any length). Creating, resizing and typing lengths all snap to it.
5. **Loop.** Click ▶ on a window, or press <kbd>L</kbd>, to loop it. Short windows stay fully cached and loop without re-decoding.
6. **Crop.** Drag the box to move it, the handles to resize, and the round handle to rotate. Drag outside the box to draw a new one. A track's output size can be derived from the crop (sides snapped to a multiple of ÷), or fixed with W × H, which locks the crop's shape. Turn on **Animate** to keyframe the crop: every edit then keys it at the playhead, and keys interpolate linearly.
7. **Export** (<kbd>Ctrl</kbd>+<kbd>E</kbd>) writes one file per window plus an optional `manifest.json` with each clip's range, source frames, size and crop keys.

Press <kbd>?</kbd> in the app for all shortcuts. Projects autosave per video file in the browser, and **Save project** writes them to JSON.

## How it stays frame-exact

- **Index.** On open, every packet's timestamp is read without decoding. For MP4/MOV this comes from the sample table, so a two-hour file opens in under a second. Frames are addressed by index, never by approximate time.
- **Decoding.** WebCodecs decodes in hardware. One decode session runs from the needed keyframe; anything wanted ahead of it in the same or next GOP comes from that session, so stepping, playback and looping never re-decode. Frames are cached as full-resolution bitmaps within a configurable budget (Frame cache, default 1 GB).
- **One render path.** The Output panel and the exporter call the same render function on frames copied the same way, so the preview is the encoded frame.
- **Color.** Untagged video is decoded with the BT.601 matrix, as ffmpeg, PyAV and OpenCV do. This can be switched to BT.709. Exports are tagged BT.709.

## Limits

- Export is video only; audio is not carried over.
- At 4K a 1 GB cache holds about 30 frames. Playback stays real-time, but loops longer than that decode while they play. A random seek costs a decode from the previous keyframe (about 0.3 s for a 2-second GOP at 4K).
- Containers on the ffmpeg path (AVI, FLV, …) have no sample table, so the first open reads through the whole file to build the index.
- MP4 export uses H.264, which needs even output sides (÷ of 2 or more).
