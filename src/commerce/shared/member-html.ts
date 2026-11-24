/** Extract a complete standalone page from a skill reply for offline delivery. */
export function memberHtmlDocument(text:string):string|undefined {
  const fenced=Array.from(text.matchAll(/^\x60\x60\x60html[^\S\n]*\r?\n([\s\S]*?)\r?\n\x60\x60\x60[ \t]*$/gim),match=>match[1].trim());
  return [...fenced,text.trim()].find(source =>
    /^(?:<!doctype\s+html\s*>\s*)?<html\b/i.test(source) && /<body\b[\s\S]*<\/body>\s*<\/html>\s*$/i.test(source)
  );
}

