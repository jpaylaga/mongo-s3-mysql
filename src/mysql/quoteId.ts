import msmError from '#runtime/msmError';

/** Backtick-quotes a MySQL identifier. Only what MySQL itself refuses is refused here. */
export default function quoteId(name: string): string {
  if (name.length === 0 || name.length > 64 || name.includes('\0')) {
    throw msmError(
      'config',
      `invalid MySQL identifier ${JSON.stringify(name)}: 1 to 64 characters, no NUL`
    );
  }

  return `\`${name.replace(/`/g, '``')}\``;
}
