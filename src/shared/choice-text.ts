/** The interface owns option numbering; preserve quantities and decimal numbers. */
export function cleanChoiceText(text: string): string {
  return text.trim().replace(/^(?:\d{1,2}[.)]|\(\d{1,2}\))\s+(?=\p{L})/u, '');
}
