import { PDFDocument } from '../vendor/pdf-lib/pdf-lib.min';

export const maxPdfBytes = 24 * 1024 * 1024;
export const maxOutputPages = 300;

export function selectedPages(selection: string, count: number): number[] {
  const result: number[] = [];
  const ranges = selection.trim() || '1-' + count;
  for (const part of ranges.split(/[,，]/)) {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part.trim());
    if (!match) throw Error('页码请写成 1,3-5 或 5-3');
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    if (first < 1 || last < 1 || first > count || last > count) throw Error('页码超出文件范围');
    const length = Math.abs(last - first) + 1;
    if (result.length + length > maxOutputPages) throw Error('每次最多导出 300 页');
    for (let i = 0; i < length; i++) result.push(first - 1 + i * (last < first ? -1 : 1));
  }
  return result;
}

export async function readPdf(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw Error('所选文件缺少 PDF 文件头');
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    if (pdf.getPageCount() < 1) throw Error();
    return pdf;
  } catch { throw Error('无法打开这份 PDF，请选择可正常阅读且未加密的文件'); }
}

export async function arrangePdf(sources: PDFDocument[], selections: string[]) {
  const result = await PDFDocument.create({ updateMetadata:false });
  for (const [i, source] of sources.entries()) {
    const indices = selectedPages(selections[i], source.getPageCount());
    if (result.getPageCount() + indices.length > maxOutputPages) throw Error('每次最多导出 300 页');
    for (const page of await result.copyPages(source, indices)) result.addPage(page);
  }
  return { bytes: Buffer.from(await result.save()), count: result.getPageCount() };
}
