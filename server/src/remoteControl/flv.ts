/**
 * Incremental FLV demuxer for ffmpeg's `-f flv` H.264 output.
 *
 * FLV is used as the pipe format because every tag carries its own length: a frame is emitted the
 * moment its last byte arrives. Raw Annex-B has no length, so a splitter only learns a frame ended
 * when the NEXT one starts, which costs a full frame of latency. The AVC payload is already in the
 * length-prefixed AVCC layout WebCodecs decodes when given the sequence header as `description`.
 */

export type FlvPacket =
  | { kind: "config"; avcc: Buffer; codec: string }
  | { kind: "frame"; key: boolean; timestampMs: number; data: Buffer };

const FILE_HEADER_BYTES = 9;
const PREVIOUS_TAG_SIZE_BYTES = 4;
const TAG_HEADER_BYTES = 11;
const TAG_VIDEO = 9;
const CODEC_AVC = 7;
const AVC_SEQUENCE_HEADER = 0;
const AVC_NALU = 1;
// The CBR buffer caps a 4K keyframe well under 1 MB; a tag past this is a corrupt length field.
const MAX_TAG_BYTES = 8 * 1024 * 1024;

export class FlvDemuxer {
  private buffer: Buffer = Buffer.alloc(0);
  private headerRead = false;

  /** Feed a stdout chunk; returns every packet it completed. Throws on a stream that is not FLV. */
  push(chunk: Buffer): FlvPacket[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const packets: FlvPacket[] = [];
    if (!this.headerRead && !this.readFileHeader()) return packets;
    for (;;) {
      const tag = this.nextTag();
      if (!tag) break;
      const packet = parseTag(tag.type, tag.timestampMs, tag.body);
      if (packet) packets.push(packet);
    }
    return packets;
  }

  private readFileHeader(): boolean {
    const needed = FILE_HEADER_BYTES + PREVIOUS_TAG_SIZE_BYTES;
    if (this.buffer.length < needed) return false;
    if (this.buffer.toString("latin1", 0, 3) !== "FLV") throw new Error("encoder output is not an FLV stream");
    const headerSize = this.buffer.readUInt32BE(5);
    if (this.buffer.length < headerSize + PREVIOUS_TAG_SIZE_BYTES) return false;
    this.buffer = this.buffer.subarray(headerSize + PREVIOUS_TAG_SIZE_BYTES);
    this.headerRead = true;
    return true;
  }

  private nextTag(): { type: number; timestampMs: number; body: Buffer } | null {
    if (this.buffer.length < TAG_HEADER_BYTES) return null;
    const type = this.buffer[0]! & 0x1f;
    const size = this.buffer.readUIntBE(1, 3);
    if (size > MAX_TAG_BYTES) throw new Error(`FLV tag of ${size} bytes is not plausible`);
    const total = TAG_HEADER_BYTES + size + PREVIOUS_TAG_SIZE_BYTES;
    if (this.buffer.length < total) return null;
    // 24-bit timestamp plus an 8-bit extension that holds the high byte.
    const timestampMs = (this.buffer[7]! << 24 >>> 0) + this.buffer.readUIntBE(4, 3);
    // Copy, not subarray: the packet outlives this buffer and a view would pin the whole chunk.
    const body = Buffer.from(this.buffer.subarray(TAG_HEADER_BYTES, TAG_HEADER_BYTES + size));
    this.buffer = this.buffer.subarray(total);
    return { type, timestampMs, body };
  }
}

function parseTag(type: number, timestampMs: number, body: Buffer): FlvPacket | null {
  if (type !== TAG_VIDEO || body.length < 5) return null;
  const frameType = body[0]! >> 4;
  const codecId = body[0]! & 0x0f;
  if (codecId !== CODEC_AVC) throw new Error(`FLV video codec ${codecId} is not H.264`);
  const packetType = body[1];
  const data = body.subarray(5);
  if (packetType === AVC_SEQUENCE_HEADER) return { kind: "config", avcc: data, codec: avcCodecString(data) };
  if (packetType === AVC_NALU && data.length > 0) return { kind: "frame", key: frameType === 1, timestampMs, data };
  return null;
}

/** RFC 6381 codec string from an AVCDecoderConfigurationRecord: profile, constraint flags, level. */
export function avcCodecString(avcc: Buffer): string {
  if (avcc.length < 4 || avcc[0] !== 1) throw new Error("AVC sequence header is not an AVCDecoderConfigurationRecord");
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(avcc[1]!)}${hex(avcc[2]!)}${hex(avcc[3]!)}`;
}
