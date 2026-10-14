import isObject from '#ejson/isObject';
import isWrapper from '#ejson/isWrapper';

/**
 * What JSON.parse gave for one line, described for an error message without echoing a long value.
 */
export default function describeValue(value: unknown): string {
  if (value === undefined) return 'missing';

  if (value === null) return 'null';

  if (Array.isArray(value)) return 'an array';

  if (isObject(value))
    return isWrapper(value) ? `a ${Object.keys(value).join('/')} value` : 'an object';

  return `a ${typeof value}`;
}
