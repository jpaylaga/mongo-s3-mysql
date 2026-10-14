/** How many lines of a record error are kept: the zod path and message, not the whole prettified tree. */
const recordErrorLines = 4;

/** The reason a record failed, with the zod detail that names the field, so nobody has to download it to find out. */
export default function recordError(message: string): string {
  return `record: ${message.split('\n').slice(0, recordErrorLines).map((l) => l.trim()).filter(Boolean).join('; ')}`;
}
