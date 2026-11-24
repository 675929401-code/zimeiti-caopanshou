import MarkdownIt from 'markdown-it';
import { strToU8, zipSync } from 'fflate';

const parser = new MarkdownIt({ html: false });
type Token = ReturnType<typeof parser.parse>[number];
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function escapeXml(text: string) {
  return text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function run(text: string, format = '') {
  return '<w:r>' + (format ? '<w:rPr>' + format + '</w:rPr>' : '') +
    '<w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r>';
}

function inline(tokens: Token[]) {
  let bold = 0, italic = 0, link = '';
  const output: string[] = [];
  for (const token of tokens) {
    const format = (bold ? '<w:b/>' : '') + (italic ? '<w:i/>' : '');
    switch (token.type) {
      case 'strong_open': bold++; break;
      case 'strong_close': bold--; break;
      case 'em_open': italic++; break;
      case 'em_close': italic--; break;
      case 'link_open': link = token.attrGet('href') || ''; break;
      case 'link_close': if (link) output.push(run(' (' + link + ')')); link = ''; break;
      case 'softbreak': case 'hardbreak': output.push('<w:r><w:br/></w:r>'); break;
      case 'code_inline': output.push(run(token.content, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')); break;
      case 'image': output.push(run(token.content || '图片', format)); break;
      default: if (token.content) output.push(run(token.content, format));
    }
  }
  return output.join('');
}

type WordList = { id: number; start: number; ordered: boolean; indent: number; firstParagraph: boolean };

function listDefinitions(lists: WordList[]) {
  const definitions = lists.map(({id, start, ordered, indent}) =>
    '<w:abstractNum w:abstractNumId="' + id + '"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="' + start + '"/><w:numFmt w:val="' + (ordered ? 'decimal' : 'bullet') + '"/>' +
    '<w:lvlText w:val="' + (ordered ? '%1.' : '•') + '"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="' +
    indent + '"/></w:tabs><w:ind w:left="' + indent + '" w:hanging="300"/></w:pPr></w:lvl></w:abstractNum>');
  const instances = lists.map(({id}) => '<w:num w:numId="' + id + '"><w:abstractNumId w:val="' + id + '"/></w:num>');
  return '<w:numbering xmlns:w="' + wordNamespace + '">' + definitions.join('') + instances.join('') + '</w:numbering>';
}

function body(tokens: Token[], definitions: WordList[]) {
  const pieces: string[] = [];
  const lists: WordList[] = [];
  let quoteDepth = 0;
  let heading = 0;
  for (const [i, token] of tokens.entries()) {
    const list = lists.at(-1);
    switch (token.type) {
      case 'heading_open': heading = Number(token.tag.slice(1)); break;
      case 'heading_close': heading = 0; break;
      case 'blockquote_open': quoteDepth++; break;
      case 'blockquote_close': quoteDepth--; break;
      case 'ordered_list_open': case 'bullet_list_open': {
        const def = { id: definitions.length + 1, start: Number(token.attrGet('start') || 1), ordered: token.type === 'ordered_list_open', indent: (lists.length + 1 + quoteDepth) * 360, firstParagraph: false };
        definitions.push(def);
        lists.push(def);
        break;
      }
      case 'ordered_list_close': case 'bullet_list_close': lists.pop(); break;
      case 'list_item_open': if (list) list.firstParagraph = true; break;
      case 'inline': {
        const style = heading ? '<w:pStyle w:val="Heading' + heading + '"/>' : '';
        const quoteStyle = quoteDepth ? '<w:pStyle w:val="Quote"/>' : '';
        const numbering = list?.firstParagraph ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + list.id + '"/></w:numPr>' : '';
        const depth = lists.length + quoteDepth;
        const indent = depth ? '<w:ind w:left="' + depth * 360 + '"/>' : '';
        pieces.push('<w:p><w:pPr>' + (style || quoteStyle) + numbering + indent + '</w:pPr>' + inline(token.children || []) + '</w:p>');
        if (list) list.firstParagraph = false;
        break;
      }
      case 'fence': case 'code_block':
        for (const line of token.content.replace(/\n$/, '').split('\n')) pieces.push('<w:p>' + run(line, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>') + '</w:p>');
        break;
      case 'table_open': {
        let columns = 0;
        for (let j = i + 1; j < tokens.length && tokens[j].type !== 'tr_close'; j++) {
          if (tokens[j].type === 'th_open') columns++;
        }
        pieces.push('<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>' +
          '<w:gridCol/>'.repeat(columns) + '</w:tblGrid>');
        break;
      }
      case 'table_close': pieces.push('</w:tbl>'); break;
      case 'tr_open': pieces.push('<w:tr>'); break;
      case 'tr_close': pieces.push('</w:tr>'); break;
      case 'td_open': case 'th_open': pieces.push('<w:tc>'); break;
      case 'td_close': case 'th_close': pieces.push('</w:tc>'); break;
      case 'hr': pieces.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr></w:pPr></w:p>'); break;
    }
  }
  return pieces.join('');
}

export function markdownToWord(text: string) {
  if (!text.trim() || text.length > 100_000) throw Error('请输入 1 至 100000 个字符的 Markdown 正文');
  const lists: WordList[] = [];
  const document = '<w:document xmlns:w="' + wordNamespace + '"><w:body>' + body(parser.parse(text, {}), lists) +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  const styles = '<w:styles xmlns:w="' + wordNamespace + '"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="8" w:space="6" w:color="A0A0A0"/></w:pBdr></w:pPr></w:style>' +
    [32, 28, 26, 24, 22, 22].map((size, i) => '<w:style w:type="paragraph" w:styleId="Heading' + (i+1) + '"><w:name w:val="heading ' + (i+1) + '"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="' + i + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + size + '"/></w:rPr></w:style>').join('') + '</w:styles>';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const relationships = (parts: [string, string][]) => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + parts.map(([type,target],i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + rel + type + '" Target="' + target + '"/>').join('') + '</Relationships>';
  const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>';
  const entries = { '[Content_Types].xml': types, '_rels/.rels': relationships([['officeDocument', 'word/document.xml']]), 'word/document.xml': document, 'word/_rels/document.xml.rels': relationships([['styles', 'styles.xml'], ['numbering', 'numbering.xml']]), 'word/styles.xml': styles, 'word/numbering.xml': listDefinitions(lists) };
  const files = Object.fromEntries(Object.entries(entries).map(([name, xml]) => [name, strToU8(xmlHeader + xml)]));
  return Buffer.from(zipSync(files, { mtime: new Date(2000, 0, 1), level: 6 }));
}
