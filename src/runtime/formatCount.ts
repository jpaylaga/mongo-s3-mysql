/** `1234567` as `1,234,567`: every count in an event or summary line goes through here. */
export default function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
