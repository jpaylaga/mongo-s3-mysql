/**
 * Archive text reaches the terminal through events and tables: document ids, reject reasons,
 * JSON.parse snippets. A control character planted there (ESC, BEL, C1) would be executed by the
 * terminal, so every one is shown as its `\\uXXXX` escape. Tabs and newlines stay; JSON output is
 * already escaped.
 */
export default function escapeControl(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}
