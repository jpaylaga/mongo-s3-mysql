import isObject from './isObject.js';

/** Whether a decoded line is a document with an `_id` (null: it is not JSON at all); the only content rule beyond "it parses". */
export default function lineHasId(line: string): boolean | null {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return null;
  }
  return isObject(doc) && Object.hasOwn(doc, '_id');
}
