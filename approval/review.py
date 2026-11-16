#!/usr/bin/env python3
"""결재 검토 작업기 (Cloud Run 서버가 불러 씀).

사용법
  python3 -I review.py case <파일경로> <작업폴더>   결재 1건(zip 1개 또는 낱개 파일 1개)을 검토하고 진행 상황·결과를 JSON 줄로 출력
  python3 -I review.py prep <파일경로> <작업폴더> <꾸러미폴더>   AI 호출 없이 가린 자료만 꾸러미로 저장(루틴 방식)
  파일경로가 .zip 이면 풀어서 안의 본문(.mht)·첨부를 보고, 아니면(PDF·HWP·HWPX·XLSX·DOCX·이미지·TXT·CSV 등)
  그 파일 하나를 1건으로 봅니다(예산서처럼 낱개로 올린 서류).
  python3 -I review.py summary                      표준입력의 건별 결과(JSON 배열)로 전체 한 줄 요약을 만듦

출력은 한 줄에 JSON 하나:
  {"type":"stage","stage":"unzip|extract|attach|review|done","msg":"..."}
  {"type":"case","result":{...}}   또는 {"type":"error","msg":"..."}
주민등록번호·면허번호 같은 원문은 절대 출력하지 않는다(로그에도 OCR 원문 금지).
"""
import base64, email, html, io, json, os, re, shutil, subprocess, sys, zipfile
from email import policy

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = open(os.path.join(HERE, "rules.md"), encoding="utf-8").read()
MODEL = os.environ.get("APPROVAL_MODEL", "claude-opus-5-5")

MAX_FILES = 300                 # zip 안 파일 수
MAX_TOTAL = 300 * 1024 * 1024   # 풀었을 때 총 크기
MAX_RATIO = 200                 # 압축률(폭탄 방지)
MAX_IMAGES = 12                 # AI 로 보낼 이미지 수
MAX_TEXT = 120_000              # AI 로 보낼 텍스트 글자 수

PII_NAME = re.compile(r"(통장|신분증|주민|면허|등록증|여권)")
RRN = re.compile(r"\d{6}\s*-?\s*[1-8]\d{6}")
LICENSE = re.compile(r"\d{2}\s*-\s*\d{6}\s*-\s*\d{2}")
ACCOUNT = re.compile(r"\d{2,6}(?:\s*-\s*\d{2,8}){1,3}")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
OOXML_EXT = {".xlsx", ".xlsm", ".docx", ".hwpx"}   # 안이 XML 인 zip 형식 문서
TEXT_EXT = {".txt", ".csv", ".tsv", ".md"}
OLD_EXT = {".xls", ".doc", ".ppt", ".pptx", ".cell", ".show"}  # 글자를 뽑지 못하는 형식 → 직접 확인


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def stage(name, msg=""):
    emit({"type": "stage", "stage": name, "msg": msg})


def scrub(text):
    """보고서·출력에 개인식별번호가 남지 않도록 가린다."""
    text = RRN.sub("[주민번호 가림]", text)
    text = LICENSE.sub("[면허번호 가림]", text)
    return text


# ── 1. zip 해제 (cp949 파일명, 경로 조작·압축 폭탄 방지) ─────────────────
def fix_name(info):
    name = info.filename
    if not info.flag_bits & 0x800:  # UTF-8 표시가 없으면 cp437 로 읽힌 것 → cp949 로 다시
        try:
            name = name.encode("cp437").decode("cp949")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    name = re.sub(r"#U([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), name)
    return name


def safe_unzip(zpath, dest):
    with zipfile.ZipFile(zpath) as z:
        infos = z.infolist()
        if len(infos) > MAX_FILES:
            raise ValueError(f"zip 안 파일이 너무 많습니다({len(infos)}개)")
        total = sum(i.file_size for i in infos)
        packed = max(1, sum(i.compress_size for i in infos))
        if total > MAX_TOTAL or total / packed > MAX_RATIO:
            raise ValueError("압축을 풀면 너무 커지는 파일이라 검토하지 않습니다")
        out = []
        root = os.path.realpath(dest)
        for i in infos:
            if i.is_dir():
                continue
            name = fix_name(i).replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".", "..")]
            if not parts:
                continue
            target = os.path.realpath(os.path.join(dest, *parts))
            if not target.startswith(root + os.sep):
                continue  # 경로 조작
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(i) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            out.append(target)
        return out


# ── 2. 본문 .mht (mht.py 방식) ─────────────────────────────────────────
def mht_text(path):
    m = email.message_from_binary_file(open(path, "rb"), policy=policy.default)
    for part in m.walk():
        if part.get_content_type() == "text/html":
            h = part.get_payload(decode=True).decode("utf-8", "replace")
            h = re.sub(r"(?is)<(script|style).*?</\1>", "", h)
            h = re.sub(r"(?is)<DATA>.*?</DATA>", "", h)
            h = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", h)
            h = re.sub(r"(?i)</t[dh]>", " | ", h)
            t = html.unescape(re.sub(r"<[^>]+>", "", h))
            t = re.sub(r"[ \t\xa0]+", " ", t)
            return re.sub(r"\n\s*\n+", "\n", t).strip()
    return ""


# ── 3. 첨부 ────────────────────────────────────────────────────────────
def run(cmd, timeout=120):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


PDF_PAGES = 8  # 스캔 PDF 를 그림으로 볼 최대 쪽수


def pdf_pages(path):
    m = re.search(r"Pages:\s+(\d+)", run(["pdfinfo", path]))
    return int(m.group(1)) if m else 0


def pdf_attach(path, work):
    text = run(["pdftotext", "-layout", path, "-"]).strip()
    images = []
    if len(text) < 30:  # 글자가 없는 스캔 PDF → 그림으로
        prefix = os.path.join(work, "pdfimg_" + re.sub(r"\W", "_", os.path.basename(path))[:40])
        run(["pdftoppm", "-r", "70", "-png", "-l", str(PDF_PAGES), path, prefix])
        images = sorted(f for f in (os.path.join(work, x) for x in os.listdir(work)) if f.startswith(prefix))
    return text, images


def hwp_attach(path, work):
    text = run(["hwp5txt", path]).strip()
    xml = run(["hwp5proc", "xml", path])
    if xml:
        cells = re.findall(r"<Text[^>]*>(.*?)</Text>", xml, flags=re.S)
        table = " | ".join(html.unescape(c).strip() for c in cells if c.strip())
        if table and table not in text:
            text += "\n[표 내용] " + table[:20000]
    imgs = []
    unpack = os.path.join(work, "hwp_" + re.sub(r"\W", "_", os.path.basename(path))[:40])
    run(["hwp5proc", "unpack", path, unpack])
    bindata = os.path.join(unpack, "BinData")
    if os.path.isdir(bindata):
        imgs = [os.path.join(bindata, f) for f in sorted(os.listdir(bindata))
                if os.path.splitext(f)[1].lower() in IMG_EXT]
    return text, imgs


def _zip_xml(path, pattern):
    """xlsx·docx·hwpx 안의 XML 중 pattern 에 맞는 것들을 (이름, 내용) 으로 돌려준다(크기 제한 포함)."""
    out = []
    with zipfile.ZipFile(path) as z:
        infos = [i for i in z.infolist() if re.search(pattern, i.filename)]
        if sum(i.file_size for i in z.infolist()) > MAX_TOTAL:
            raise ValueError("문서를 풀면 너무 커서 읽지 않습니다")
        for i in sorted(infos, key=lambda i: [int(n) if n.isdigit() else n for n in re.split(r"(\d+)", i.filename)]):
            out.append((i.filename, z.read(i).decode("utf-8", "replace")))
    return out


def _xml_text(x):
    return html.unescape(re.sub(r"<[^>]+>", "", x))


def xlsx_attach(path):
    """엑셀(.xlsx): 시트마다 '행: 셀 | 셀 | …' 형태 글자. 수식은 계산된 값과 함께 [=수식] 으로 보여 준다."""
    parts = dict(_zip_xml(path, r"^xl/(sharedStrings|workbook)\.xml$|^xl/worksheets/sheet\d+\.xml$"))
    shared = [_xml_text(si) for si in re.findall(r"(?s)<si>(.*?)</si>", parts.get("xl/sharedStrings.xml", ""))]
    names = re.findall(r'<sheet [^>]*name="([^"]*)"', parts.get("xl/workbook.xml", ""))
    lines = []
    sheets = sorted((k for k in parts if k.startswith("xl/worksheets/")), key=lambda k: int(re.sub(r"\D", "", k)))
    for n, key in enumerate(sheets):
        lines.append(f"[시트: {html.unescape(names[n]) if n < len(names) else key}]")
        for row in re.findall(r"(?s)<row[^>]*>(.*?)</row>", parts[key]):
            cells = []
            for attrs, inner in re.findall(r"(?s)<c([^>]*?)(?:/>|>(.*?)</c>)", row):
                ref = re.search(r'r="([A-Z]+\d+)"', attrs)
                v = re.search(r"(?s)<v>(.*?)</v>", inner or "")
                f = re.search(r"(?s)<f[^>]*>(.*?)</f>", inner or "")
                val = ""
                if 't="s"' in attrs and v:
                    i = int(v.group(1))
                    val = shared[i] if i < len(shared) else ""
                elif 't="inlineStr"' in attrs:
                    val = _xml_text(inner or "")
                elif v:
                    val = html.unescape(v.group(1))
                if f:
                    val += f" [={html.unescape(f.group(1))}]"
                if val.strip():
                    cells.append(f"{ref.group(1) if ref else ''}={val.strip()}")
            if cells:
                lines.append(" | ".join(cells))
    return "\n".join(lines)


def docx_attach(path):
    xml = "".join(x for _, x in _zip_xml(path, r"^word/document\.xml$"))
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"</w:tc>", " | ", xml)
    return re.sub(r"\n\s*\n+", "\n", _xml_text(xml)).strip()


def hwpx_attach(path, work):
    """한글 2014 이후 .hwpx (zip 안 Contents/section*.xml)."""
    xml = "".join(x for _, x in _zip_xml(path, r"^Contents/section\d+\.xml$"))
    xml = re.sub(r"</hp:p>", "\n", xml)
    xml = re.sub(r"</hp:tc>", " | ", xml)
    text = re.sub(r"\n\s*\n+", "\n", _xml_text(xml)).strip()
    imgs = []
    with zipfile.ZipFile(path) as z:
        for i in z.infolist():
            if i.filename.startswith("BinData/") and os.path.splitext(i.filename)[1].lower() in IMG_EXT \
                    and i.file_size < 30 * 1024 * 1024:
                dst = os.path.join(work, "hwpx_" + re.sub(r"\W", "_", os.path.basename(path))[:30] + "_"
                                   + re.sub(r"[^\w.]", "_", os.path.basename(i.filename)))
                with z.open(i) as a, open(dst, "wb") as b:
                    shutil.copyfileobj(a, b)
                imgs.append(dst)
    return text, imgs


def plain_attach(path):
    raw = open(path, "rb").read(5 * 1024 * 1024)
    for enc in ("utf-8-sig", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", "replace")


def to_png_b64(path, max_side=1568):
    from PIL import Image, ImageOps
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    if max(img.size) > max_side:
        s = max_side / max(img.size)
        img = img.resize((int(img.size[0] * s), int(img.size[1] * s)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def mask_image(path, work, accounts):
    """mask_pii.py 로 가린 사본을 만든다. safe_to_view 가 true 일 때만 그 사본 경로를 돌려준다."""
    out = os.path.join(work, "masked")
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "mask_pii.py"), path, out, *accounts],
                       capture_output=True, timeout=180)
    try:
        info = json.loads(r.stdout.decode("utf-8", "replace"))
    except ValueError:
        return None, {"safe_to_view": False, "id_card_suspected": False}
    return (info["masked_image"] if info.get("safe_to_view") else None), info


def write_package(content, pii_notes, name, outdir):
    """AI 로 보낼 내용(이미 가린 텍스트·이미지)을 outdir 에 case.json + imgNN.png 로 저장."""
    os.makedirs(outdir, exist_ok=True)
    text, images, label = "", [], ""
    for c in content:
        if c["type"] == "text":
            if c["text"].startswith("[이미지: "):
                label = c["text"][len("[이미지: "):-1]
            elif not text:
                text = c["text"]
        elif c["type"] == "image":
            fn = f"img{len(images) + 1:02d}.png"
            with open(os.path.join(outdir, fn), "wb") as f:
                f.write(base64.b64decode(c["source"]["data"]))
            images.append({"label": scrub(label), "file": fn})
    pkg = {"file": name, "text": text, "images": images, "pii_notes": [scrub(x) for x in pii_notes]}
    with open(os.path.join(outdir, "case.json"), "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False)


# ── 4. 건별 검토 ───────────────────────────────────────────────────────
CASE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string"},
        "drafter": {"type": "string"},
        "amount": {"type": "string"},
        "needs_check": {"type": "boolean"},
        "issues": {"type": "array", "items": {"type": "string"}},
        "ok_note": {"type": "string"},
        "pii_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "drafter", "amount", "needs_check", "issues", "ok_note", "pii_notes"],
}

WEB_NOTE = """
[웹 결재검토 페이지에서의 작업 방식]
- 위 규칙의 '대상'과 '처리 순서'(Drive 검색·다운로드·검토이력·결과 문서 저장)는 서버가 대신 처리했습니다. 당신은 아래에 주어진 결재 1건의 본문·첨부 내용만 보고 '점검 항목'을 대조합니다.
- 개인정보 처리는 서버가 이미 했습니다. "직접 대조 필요"로 표시된 이미지는 받지 못한 것이니 그 사실만 pii_notes 에 적습니다.
- 결과는 지정한 JSON 형식으로만 답합니다. issues 는 "문제 한 줄 + 근거(문서 A의 값 vs 문서 B의 값)" 형태의 문장 목록, 문제가 없으면 빈 목록과 ok_note(확인한 내용 한 줄).
- 주민등록번호, 면허번호, 개인 주소, 생년월일은 어떤 칸에도 옮겨 적지 않습니다.
"""


def call_claude(content, schema=None, max_tokens=16000):
    import anthropic
    client = anthropic.Anthropic()
    kwargs = dict(
        model=MODEL,
        max_tokens=max_tokens,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive"},
        system=[{"type": "text", "text": RULES + WEB_NOTE, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    )
    out_cfg = {"effort": "high"}
    if schema:
        out_cfg["format"] = {"type": "json_schema", "schema": schema}
    kwargs["output_config"] = out_cfg
    with client.beta.messages.stream(**kwargs) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise RuntimeError("AI 가 이 건의 검토를 거절했습니다")
    return "".join(b.text for b in msg.content if b.type == "text")


def review_case(zpath, work, outdir=None):
    name = os.path.basename(zpath)
    single = not name.lower().endswith(".zip")
    if single:  # zip 이 아닌 낱개 파일 1개 = 1건
        stage("unzip", "낱개 파일 준비")
        os.makedirs(os.path.join(work, "one"), exist_ok=True)
        dst = os.path.join(work, "one", re.sub(r"[/\\]", "_", name) or "file")
        shutil.copyfile(zpath, dst)
        files = [dst]
    else:
        stage("unzip", "압축 해제")
        files = safe_unzip(zpath, os.path.join(work, "unz"))

    stage("extract", "본문 추출")
    bodies = [mht_text(f) for f in files if f.lower().endswith(".mht")]
    body = "\n\n".join(b for b in bodies if b)

    stage("attach", "첨부 분석")
    texts, images, pii_notes = [], [], []
    for f in files:
        base = os.path.basename(f)
        ext = os.path.splitext(f)[1].lower()
        try:
            if ext in (".xlsx", ".xlsm"):
                t = xlsx_attach(f)
                texts.append(f"[첨부 엑셀: {base}]\n{t}" if t else "")
                if not t:
                    pii_notes.append(f"{base}: 엑셀 글자를 읽지 못함 - 직접 확인 필요")
                continue
            if ext == ".docx":
                t = docx_attach(f)
                texts.append(f"[첨부 워드: {base}]\n{t}" if t else "")
                if not t:
                    pii_notes.append(f"{base}: 워드 글자를 읽지 못함 - 직접 확인 필요")
                continue
            if ext == ".hwpx":
                t, imgs = hwpx_attach(f, work)
                texts.append(f"[첨부 HWPX: {base}]\n{t}" if t else "")
                if not t and not imgs:
                    pii_notes.append(f"{base}: HWPX 파일을 읽지 못함 - 직접 확인 필요")
                for im in imgs:
                    images.append((f"{base} 안 그림", im, bool(PII_NAME.search(base))))
                continue
        except (zipfile.BadZipFile, ValueError, KeyError):
            pii_notes.append(f"{base}: 파일이 깨졌거나 너무 커서 읽지 못함 - 직접 확인 필요")
            continue
        if ext in TEXT_EXT:
            texts.append(f"[첨부 텍스트: {base}]\n{plain_attach(f)}")
        elif ext in OLD_EXT:
            pii_notes.append(f"{base}: 이 형식({ext})은 글자를 읽지 못함 - PDF·XLSX·HWP 로 다시 올리거나 직접 확인 필요")
        elif ext == ".pdf":
            t, imgs = pdf_attach(f, work)
            if t:
                texts.append(f"[첨부 PDF: {base}]\n{t}")
            elif not imgs:
                pii_notes.append(f"{base}: PDF 를 읽지 못함 - 직접 확인 필요")
            if imgs and pdf_pages(f) > len(imgs):
                pii_notes.append(f"{base}: 스캔 PDF {pdf_pages(f)}쪽 중 앞 {len(imgs)}쪽만 검토함 - 나머지 쪽 직접 확인 필요")
            for im in imgs:
                images.append((f"{base} (스캔 쪽)", im, bool(PII_NAME.search(base))))
        elif ext in (".hwp", ".hwpx"):
            t, imgs = hwp_attach(f, work)
            if t:
                texts.append(f"[첨부 HWP: {base}]\n{t}")
            elif not imgs:
                pii_notes.append(f"{base}: HWP 파일을 읽지 못함 - 직접 확인 필요")
            for im in imgs:
                images.append((f"{base} 안 그림", im, bool(PII_NAME.search(base))))
        elif ext in IMG_EXT:
            images.append((base, f, True if PII_NAME.search(base) else None))
        elif single and ext not in (".mht",):
            pii_notes.append(f"{base}: 읽을 수 없는 형식 - 직접 확인 필요")

    texts = [t for t in texts if t]
    # 통장사본 대조용 계좌번호: 본문(.mht), 낱개 파일이면 그 글자에서
    acc_src = body if body else "\n".join(texts)
    body_accounts = sorted({re.sub(r"\s", "", m.group()) for m in ACCOUNT.finditer(acc_src)
                            if 10 <= len(re.sub(r"\D", "", m.group())) <= 16})

    content, sent = [], 0
    for label, path, pii in images:
        if sent >= MAX_IMAGES:
            pii_notes.append(f"{label}: 이미지가 많아 일부만 검토함 - 직접 확인 필요")
            continue
        # 개인 서류(파일명 기준) 또는 판단이 애매한 사진 이미지는 mask_pii 를 먼저 거친다
        if pii is not False:
            masked, info = mask_image(path, work, body_accounts)
            if info.get("id_card_suspected"):
                pii_notes.append(f"{label}: 신분증 동봉 의심 – 가린 사본으로 교체 요청")
            if not masked:
                if pii:  # 통장사본 등
                    pii_notes.append(f"{label}: 통장사본 자동 대조 불가 – 직접 확인 필요")
                    continue
                if info.get("rrn_masked") or info.get("license_no_masked") or info.get("id_card_suspected"):
                    pii_notes.append(f"{label}: 개인식별번호가 보여 AI 에 보내지 않음 – 직접 확인 필요")
                    continue
                masked = path  # 사업자 서류(영수증·견적서 등)로 보이면 원본 사용
            path = masked
        try:
            content.append({"type": "text", "text": f"[이미지: {label}]"})
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                        "data": to_png_b64(path)}})
            sent += 1
        except Exception:
            pii_notes.append(f"{label}: 이미지를 열 수 없음 - 직접 확인 필요")

    if single and not body:
        head = f"[결재 파일: {name}]\n[낱개 파일 1건 — 전자결재 본문(.mht) 없이 올린 서류입니다. 아래 내용이 그 파일입니다]\n\n"
    else:
        head = f"[결재 파일: {name}]\n[본문]\n{body or '(본문 .mht 를 찾지 못함)'}\n\n"
    doc = head + "\n\n".join(texts)
    doc = scrub(doc)[:MAX_TEXT]
    if pii_notes:
        doc += "\n\n[서버 개인정보 처리 메모]\n" + "\n".join("- " + p for p in pii_notes)
    content.insert(0, {"type": "text", "text": doc})
    content.append({"type": "text", "text": "위 결재 1건을 점검 항목대로 검토해 JSON 으로 답하세요."})

    if outdir:  # 루틴 방식: 가린 자료만 꾸러미로 저장하고 끝 (AI 호출은 루틴이 함)
        stage("pack", "가린 자료 꾸러미 만들기")
        write_package(content, pii_notes, name, outdir)
        stage("done", "완료")
        emit({"type": "prepared", "file": name})
        return

    stage("review", "검토 중")
    result = json.loads(call_claude(content, CASE_SCHEMA))
    result["pii_notes"] = sorted(set(result.get("pii_notes", []) + pii_notes))
    result["file"] = name
    for k, v in list(result.items()):
        if isinstance(v, str):
            result[k] = scrub(v)
        elif isinstance(v, list):
            result[k] = [scrub(x) for x in v]
    stage("done", "완료")
    emit({"type": "case", "result": result})


def summary():
    cases = json.load(sys.stdin)
    brief = json.dumps([{k: c.get(k) for k in ("title", "amount", "needs_check", "issues", "pii_notes")}
                        for c in cases], ensure_ascii=False)
    text = call_claude([{"type": "text", "text":
                         "다음은 오늘 검토한 결재들의 결과입니다. 결과 형식의 마지막 줄처럼, 가장 급한 것 한두 개를 "
                         "한국어 한 줄(120자 이내)로만 요약하세요. 다른 말은 쓰지 마세요.\n" + brief}],
                       max_tokens=4000)
    emit({"type": "summary", "text": scrub(text.strip().splitlines()[-1] if text.strip() else "")})


if __name__ == "__main__":
    try:
        if sys.argv[1] == "case":
            review_case(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == "prep":
            review_case(sys.argv[2], sys.argv[3], sys.argv[4])
        elif sys.argv[1] == "summary":
            summary()
    except zipfile.BadZipFile:
        emit({"type": "error", "msg": "zip 파일이 아니거나 깨져 있습니다"})
        sys.exit(1)
    except Exception as e:  # 원문 노출 없이 짧은 이유만
        emit({"type": "error", "msg": scrub(str(e))[:300]})
        sys.exit(1)
