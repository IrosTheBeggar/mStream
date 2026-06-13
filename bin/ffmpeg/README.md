ffmpeg + ffprobe binaries are auto-downloaded here on first boot (unless
`transcode.ffmpegDirectory` points somewhere else) and auto-updated weekly.

Set `transcode.autoUpdate: false` in your config to pin the current build.
Binaries you place in a custom `ffmpegDirectory` yourself are never
auto-updated — mStream only updates builds it installed itself.
