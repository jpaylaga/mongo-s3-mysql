/**
 * The one serialization of every record the tool writes to S3: pretty-printed, trailing newline.
 */
export default function recordJson(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
