import { createInterface } from 'node:readline/promises';

/** Prompts on stderr (stdout carries the result); without a TTY the caller must pass `--yes`. */
export default async function confirm(question: string, skip?: boolean): Promise<void> {
  if (skip) return;
  if (!process.stdin.isTTY) throw new Error('not a TTY: pass --yes to confirm');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('aborted');
}
