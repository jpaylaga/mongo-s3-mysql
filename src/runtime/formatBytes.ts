const units = ['B', 'KB', 'MB', 'GB', 'TB'];

/** `329849` as `322.1 KB`: the prompt and summary form of a byte count. */
export default function formatBytes(bytes: number): string {
  let v = bytes;
  let u = 0;

  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }

  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}
