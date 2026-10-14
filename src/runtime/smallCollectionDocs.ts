/** Below this many documents one keyset walk is cheap: inventory suggests `full-collection` and `rest: auto` plans the rest chunk. */
const smallCollectionDocs = 1_000_000;

export default smallCollectionDocs;
