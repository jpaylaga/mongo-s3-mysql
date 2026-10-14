/** `date` rounded down to a multiple of `step` milliseconds since the epoch: the UTC hour or day grid. */
export default function floorTo(date: Date, step: number): Date {
  return new Date(Math.floor(date.getTime() / step) * step);
}
