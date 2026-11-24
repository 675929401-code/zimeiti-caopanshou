/** Types used by the commerce PDF page organizer, from pdf-lib 1.17.1. */
export class PDFPage { private readonly embeddedPage: never; }
export class PDFDocument {
  static load(data: Uint8Array, options: { updateMetadata: boolean }): Promise<PDFDocument>;
  static create(options: { updateMetadata: boolean }): Promise<PDFDocument>;
  getPageCount(): number;
  copyPages(source: PDFDocument, indices: number[]): Promise<PDFPage[]>;
  addPage(page: PDFPage): PDFPage;
  save(): Promise<Uint8Array>;
}
