const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MIN_FRAME_BYTES = 256;

/**
 * Splits ffmpeg's `mpjpeg` output into JPEG frames. Each part carries an explicit Content-Length, so frames
 * are cut by byte count rather than by hunting for SOI/EOI markers, which an embedded EXIF thumbnail breaks.
 */
export class MultipartJpegParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (frame: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) break;
      const length = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("latin1"));
      if (!length) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const start = headerEnd + HEADER_END.length;
      const end = start + Number(length[1]);
      if (this.buffer.length < end) break;
      const frame = Buffer.from(this.buffer.subarray(start, end));
      let next = end;
      while (next < this.buffer.length && (this.buffer[next] === 0x0d || this.buffer[next] === 0x0a || this.buffer[next] === 0x2d)) next += 1;
      this.buffer = this.buffer.subarray(next);
      if (frame.length >= MIN_FRAME_BYTES) this.onFrame(frame);
    }
    if (this.buffer.length > MAX_BUFFER_BYTES) this.buffer = Buffer.alloc(0);
  }
}
