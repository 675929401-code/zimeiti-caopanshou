"""Process one member document in an isolated temporary working directory."""
import base64
import csv
import io
import json
import math
import re
import sys
import zipfile
from datetime import date, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from defusedxml import ElementTree

MAX_ENTRIES = 2200
MAX_EXPANDED = 64 * 1024 * 1024
MAX_CELLS = 50000
MAX_OUTPUT = 160000


def check_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES or sum(item.file_size for item in entries) > MAX_EXPANDED:
            raise ValueError("文档解压后过大，请缩小文件")
        if any(item.flag_bits & 1 for item in entries):
            raise ValueError("请先解密文档再上传")
        for item in entries:
            if item.filename.endswith((".xml", ".rels")):
                content = archive.read(item)
                if b"<!DOCTYPE" in content or b"<!ENTITY" in content:
                    raise ValueError("无法处理包含 DTD 的文档")
        return {item.filename for item in entries}


def response(text="", **fields):
    return dict(text=text[:MAX_OUTPUT], **fields)


def result_file(suffix, **report):
    return response(extension=suffix, **report)


def value_text(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return "" if value is None else str(value)


def sheet_job(data, extension, args):
    from openpyxl import Workbook, load_workbook
    from openpyxl.utils.cell import get_column_letter, range_boundaries
    action = args["action"]
    if data and extension == "csv":
        encoding = "utf-8-sig"
        try:
            source = data.decode(encoding)
        except UnicodeDecodeError:
            source = data.decode("gb18030")
        book = Workbook()
        reader = csv.reader(io.StringIO(source, newline=""))
        cells = 0
        for row in reader:
            cells += len(row)
            if cells > MAX_CELLS or len(row) > 256 or reader.line_num > 10000:
                raise ValueError("CSV 超出读取范围")
            book.active.append(row)
            for cell in book.active[book.active.max_row][:len(row)]:
                if cell.data_type == "f":
                    cell.data_type = "s"
    elif data:
        names = check_archive(data)
        if action == "write" and (extension == "xlsm" or any(
            name.startswith(("xl/activeX/", "xl/slicers/", "xl/pivot", "xl/drawings/", "_xmlsignatures/")) for name in names
        )):
            raise ValueError("此工作簿包含宏、图形、透视表或签名，仅支持读取以保留模板")
        book = load_workbook(io.BytesIO(data), read_only=action == "read", data_only=False, keep_links=False)
    else:
        book = Workbook()
    try:
        sheet_name = args.get("sheet", "").strip()
        if sheet_name and sheet_name not in book.sheetnames:
            raise ValueError("工作表不存在，请从列表中选择")
        sheet = book[sheet_name] if sheet_name else book.active
        if action == "read":
            region = args.get("range", "").strip().upper() or "A1:" + get_column_letter(min(sheet.max_column or 12, 12)) + str(min(sheet.max_row or 30, 30))
            if not re.fullmatch(r"[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?", region):
                raise ValueError("请输入 A1:D20 格式的范围")
            c1, r1, c2, r2 = range_boundaries(region)
            if c2 < c1 or r2 < r1 or c2 > 16384 or r2 > 1048576 or (r2-r1+1)*(c2-c1+1) > 1500:
                raise ValueError("每次读取最多 1500 个单元格")
            rows = []
            for i, row in enumerate(sheet.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True), r1):
                rows.append([i] + [value_text(v) for v in row])
            text = json.dumps({"工作表":sheet.title,"范围":region,"列":[get_column_letter(i) for i in range(c1,c2+1)],"行":rows},ensure_ascii=False)
            if len(text)>MAX_OUTPUT:
                raise ValueError("单元格内容过长，请缩小读取范围")
            return response(text,sheets=book.sheetnames[:200],sheet=sheet.title,region=region)
        changes = json.loads(args["content"])
        if not isinstance(changes,dict) or not 1 <= len(changes) <= 1000:
            raise ValueError("请输入 1–1000 个单元格的修改内容")
        for address,value in changes.items():
            if not re.fullmatch(r"[A-Z]{1,3}[1-9]\d{0,6}",address) or not isinstance(value,(str,int,float,bool,type(None))):
                raise ValueError("单元格地址或数值格式无效")
            cell=sheet[address]
            if cell.column > 16384 or cell.row > 1048576:
                raise ValueError("单元格超出 Excel 范围")
            cell.value=value
        book.calculation.fullCalcOnLoad=True
        book.save("output")
        return result_file("xlsx",text=f"{sheet.title} 已写入 {len(changes)} 个单元格，公式将在 Excel 中重算。")
    finally:
        book.close()


def word_job(data, args):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph
    if data:
        check_archive(data)
    document = Document(io.BytesIO(data)) if data else Document()
    paragraphs = [Paragraph(node,document) for node in document.element.body.iter(qn("w:p"))]
    action=args["action"]
    if action=="read":
        notes=[c.text for c in document.comments]
        text="\n".join(p.text for p in paragraphs)
        if notes:
            text+="\n\n批注\n"+"\n".join(notes)
        return response(text,paragraphs=len(paragraphs),comments=len(notes))
    if action=="append":
        for line in args["content"].splitlines():
            document.add_paragraph(line)
    elif action=="comment":
        index=int(args["paragraph"])-1
        if not 0 <= index < len(paragraphs) or not paragraphs[index].runs:
            raise ValueError("请选择有文字的正文段落")
        document.add_comment(paragraphs[index].runs,text=args["content"],author="自媒体操盘手",initials="审")
    else:
        old=args.get("find","")
        if not old or "\n" in old:
            raise ValueError("请输入段落内要查找的原文")
        changed=0
        for p in paragraphs:
            runs=p.runs
            text="".join(r.text for r in runs)
            matches=list(re.finditer(re.escape(old),text))
            if not matches:
                continue
            # Preserve unaffected run formatting; never rewrite whole paragraphs.
            for match in reversed(matches):
                start,end=match.span()
                offsets=[];pos=0
                for run in runs:
                    offsets.append(pos);pos+=len(run.text)
                for i in reversed(range(len(runs))):
                    run=runs[i];lo=offsets[i];hi=lo+len(run.text)
                    if lo<end and hi>start:
                        if any(child.tag not in (qn("w:rPr"),qn("w:t")) for child in run._r):
                            raise ValueError("匹配位置含有嵌入对象或特殊域，请在 Word 中修改")
                        a=max(0,start-lo);b=min(len(run.text),end-lo)
                        insert=args["content"] if lo<=start<hi else ""
                        run.text=run.text[:a]+insert+run.text[b:]
                changed+=1
        if not changed:
            raise ValueError("没有找到可替换的原文")
    document.save("output")
    return result_file("docx",text="文档已保存。")


def pdf_job(data, args):
    from pypdf import PdfReader
    reader=PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError("请先解密 PDF")
    start=int(args.get("first",1));end=int(args.get("last",start))
    if not 1<=start<=end<=len(reader.pages) or end-start>=20:
        raise ValueError(f"文档共 {len(reader.pages)} 页，每次请选择 1–20 页")
    ocr=None;render=None;pages=[];chars=0
    for number in range(start,end+1):
        text=reader.pages[number-1].extract_text() or ""
        method="text"
        if args["action"]=="scan" or not text.strip():
            from rapidocr_onnxruntime import RapidOCR
            import pypdfium2 as pdfium
            import numpy as np
            if render is None:
                render=pdfium.PdfDocument(data)
                ocr=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1)
            page=render[number-1]
            width,height=page.get_size()
            if not (width>0 and height>0 and math.isfinite(width*height)):
                raise ValueError("PDF 页面尺寸无效")
            scale=min(2.5,2200/max(width,height))
            bitmap=page.render(scale=scale)
            try:
                rows,_=ocr(np.array(bitmap.to_pil().convert("RGB")))
                text="\n".join(row[1] for row in rows or [])
            finally:
                bitmap.close();page.close()
            method="ocr"
        chars+=len(text)
        if chars>MAX_OUTPUT:
            raise ValueError("文本过长，请缩小页码范围")
        pages.append(dict(page=number,method=method,text=text))
    if render is not None:
        render.close()
    fmt=args.get("format","txt")
    if fmt=="json":
        output=json.dumps(pages,ensure_ascii=False,indent=2)
    elif fmt=="md":
        output="\n\n".join(f"## 第 {p['page']} 页\n\n{p['text']}" for p in pages)
    else:
        output="\n\n".join(p["text"] for p in pages)
    if not any(p["text"].strip() for p in pages):
        raise ValueError("所选页面未识别出可读文字")
    Path("output").write_text(output,encoding="utf-8")
    return result_file(fmt,text=output,pageCount=len(reader.pages),methods=[p["method"] for p in pages])


def allowed_url(url, article=False):
    parsed=urlsplit(url)
    allowed={"mp.weixin.qq.com"} if article else {"mmbiz.qpic.cn","mmbiz.qlogo.cn"}
    if parsed.scheme!="https" or parsed.hostname not in allowed or parsed.port not in (443,None) or parsed.username or parsed.password:
        raise ValueError("仅支持公众号公开文章和官方正文配图地址")
    if article and not (parsed.path=="/s" or parsed.path.startswith("/s/")):
        raise ValueError("请输入公众号文章链接")
    return url


def get_public(url, article=False):
    class Redirect(HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,target):
            allowed_url(target,article)
            return super().redirect_request(req,fp,code,msg,headers,target)
    request=Request(allowed_url(url,article),headers={"User-Agent":"Mozilla/5.0"})
    with build_opener(Redirect()).open(request,timeout=6) as res:
        data=res.read(4*1024*1024+1)
    if len(data)>4*1024*1024:
        raise ValueError("文章或配图超过 4 MB")
    return data


def article_job(data,args):
    from bs4 import BeautifulSoup, NavigableString, Tag
    from docx import Document
    from docx.shared import Inches
    from PIL import Image
    public=args["action"]=="url"
    if public:
        data=get_public(args["url"],True)
    soup=BeautifulSoup(data,"html.parser",from_encoding="utf-8")
    root=soup.select_one("#js_content")
    if public and root is None:
        raise ValueError("公开链接未返回文章正文。请在普通浏览器保存文章 HTML 后导入")
    root=root or soup.body or soup
    for tag in root.select("script,style,iframe,form,noscript"):
        tag.decompose()
    doc=Document();article_title=soup.select_one("#activity-name") or soup.title
    if article_title and article_title.get_text(strip=True):
        doc.add_heading(article_title.get_text(strip=True),0)
    images=0;skipped=0;total=0
    def walk(node,p=None,bold=False,italic=False):
        nonlocal images,skipped,total
        if isinstance(node,NavigableString):
            if str(node).strip() or p is not None:
                if p is None:p=doc.add_paragraph()
                run=p.add_run(str(node));run.bold=bold;run.italic=italic
        elif isinstance(node,Tag):
            tag=node.name.lower()
            if tag=="img":
                src=node.get("data-src") or node.get("src") or ""
                if images+skipped>=50:
                    raise ValueError("单篇最多支持 50 张配图")
                try:
                    if re.match(r"^data:image/(png|jpeg|webp|gif);base64,",src,re.I):
                        body=base64.b64decode(src.split(",",1)[1],validate=True)
                    else:
                        body=get_public(urljoin("https://mp.weixin.qq.com/",src))
                    total+=len(body)
                    if total>20*1024*1024:raise OverflowError()
                    img=Image.open(io.BytesIO(body))
                    if img.width*img.height>12000000:raise OverflowError()
                    buf=io.BytesIO();img.thumbnail((1800,1800));img.convert("RGB").save(buf,format="JPEG",quality=90);buf.seek(0)
                    (p if p is not None else doc.add_paragraph()).add_run().add_picture(buf,width=Inches(5.7))
                    images+=1
                except (ValueError,OSError,URLError):
                    skipped+=1
                    (p if p is not None else doc.add_paragraph()).add_run("[配图未取得]")
            elif tag=="br":
                if p is not None:p.add_run().add_break()
            else:
                if tag in ("p","li","h1","h2","h3","h4","h5","h6"):
                    p=doc.add_heading(level=int(tag[1])) if tag.startswith("h") else doc.add_paragraph(style="List Bullet" if tag=="li" else None)
                for child in node.children:
                    walk(child,p,bold or tag in ("strong","b"),italic or tag in ("em","i"))
    walk(root)
    if not any(p.text.strip() for p in doc.paragraphs) and not images:
        raise ValueError("未找到文章正文")
    doc.save("output")
    return result_file("docx",text=f"已转换正文，嵌入 {images} 张配图；未取得 {skipped} 张。",images=images,missingImages=skipped)


def main():
    args=json.loads(Path("request.json").read_text(encoding="utf-8"))
    data=Path("input").read_bytes() if Path("input").exists() else b""
    kind=args["kind"]
    if kind=="word-tools":result=word_job(data,args)
    elif kind in ("spreadsheets","sheet-analysis"):result=sheet_job(data,args["extension"],args)
    elif kind=="pdf-ocr":result=pdf_job(data,args)
    else:result=article_job(data,args)
    Path("result.json").write_text(json.dumps(result,ensure_ascii=False),encoding="utf-8")


if __name__=="__main__":
    try:
        main()
    except Exception as exc:
        # Paths, traces and dependency internals stay out of member responses.
        message=str(exc) if isinstance(exc,ValueError) and not isinstance(exc,(UnicodeError,json.JSONDecodeError)) and re.search("[\u3400-\u9fff]",str(exc)) else "处理失败，请检查文件、格式及输入内容"
        Path("result.json").write_text(json.dumps({"error":message[:220]},ensure_ascii=False),encoding="utf-8")
        sys.exit(1)
