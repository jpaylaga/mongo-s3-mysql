import type { CommandName, Config, EventSink, RunContext } from '#types';

const noop: EventSink = () => {};

/**
 * Everything a library function needs besides its clients; library code never reads env or prints.
 */
export default function createContext(options: {
  config: Config;
  command: CommandName;
  emit?: EventSink;
  signal?: AbortSignal;
  now?: () => Date;
  secrets?: readonly string[];
}): RunContext {
  return {
    config: options.config,
    command: options.command,
    emit: options.emit ?? noop,
    signal: options.signal ?? new AbortController().signal,
    now: options.now ?? (() => new Date()),
    secrets: options.secrets ?? [],
  };
}
