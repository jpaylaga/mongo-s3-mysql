/**
 * The most a record read (`getText`) accepts by default: a chunk or batch manifest, a parse-check or a counts
 * record is a few kilobytes, and 64 MiB leaves room for a manifest with very many parts while a multi-gigabyte
 * object at a record key can no longer exhaust memory or hit V8's string limit.
 */
const recordLimitBytes = 64 * 1024 * 1024;

export default recordLimitBytes;
