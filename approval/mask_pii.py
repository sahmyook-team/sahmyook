#!/usr/bin/env python3
"""개인정보 첨부(통장사본·신분증 등) 이미지 사전 처리.

사용법: python3 -I mask_pii.py <입력이미지> <출력폴더> [본문에 적힌 계좌번호 ...]
- 주민등록번호/운전면허번호 형식의 글자를 찾아 검게 칠한 사본(masked_*.png)을 만든다.
- 신분증(주민등록증·운전면허증 등)이 같이 찍혔는지 판단한다.
- 계좌번호 후보만 뽑아 JSON으로 출력한다. 원문 OCR 텍스트와 주민번호는 절대 출력하지 않는다.
정책(fail-closed): safe_to_view 가 true 일 때만 가린 사본을 열어본다.
  safe_to_view = 신분증 의심 없음 AND 주민·면허번호 형식 없음 AND 본문 계좌번호를 OCR이 읽어냄(=글자 인식이 제대로 됐다는 증거).
  false 이면 이미지를 열지 않고 "자동 확인 불가 - 직접 대조 필요"로 보고한다.
"""
import json, os, re, sys
from PIL import Image, ImageDraw, ImageOps
import pytesseract

RRN = re.compile(r"\d{6}\s*-?\s*[1-8]\d{6}")
LICENSE = re.compile(r"\d{2}\s*-\s*\d{6}\s*-\s*\d{2}")
ACCOUNT = re.compile(r"\d{2,6}(?:\s*-\s*\d{2,8}){1,3}")
ID_WORDS = ["주민등록증", "운전면허", "면허증", "Driver", "License", "여권", "PASSPORT",
            "외국인등록", "장애인등록", "적성검사", "지방경찰청", "시장", "구청장"]
ID_STRONG = ["주민등록증", "운전면허", "면허증", "Driver", "License", "여권", "PASSPORT",
             "외국인등록", "적성검사", "경찰청"]


def ocr_words(img):
    d = pytesseract.image_to_data(img, lang="kor+eng", output_type=pytesseract.Output.DICT)
    lines = {}
    for i, t in enumerate(d["text"]):
        if not t.strip():
            continue
        key = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
        lines.setdefault(key, []).append(
            (t, d["left"][i], d["top"][i], d["width"][i], d["height"][i]))
    return list(lines.values())


def main(src, outdir, expected=()):
    os.makedirs(outdir, exist_ok=True)
    img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    scale = 1.0
    if max(img.size) > 2400:
        scale = 2400 / max(img.size)
        img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)))
    draw = ImageDraw.Draw(img)
    rrn_hits = lic_hits = 0
    id_hits = set()
    accounts = []
    for words in ocr_words(img):
        # 한 줄의 토큰을 이어 붙이고 각 글자가 어느 토큰에서 왔는지 기록
        text, owner = "", []
        for k, (t, *_b) in enumerate(words):
            if text:
                text += " "; owner.append(None)
            text += t; owner.extend([k] * len(t))
        for w in ID_WORDS:
            if w.lower() in text.lower():
                id_hits.add(w)
        sensitive = []
        for pat, kind in ((RRN, "rrn"), (LICENSE, "lic")):
            for m in pat.finditer(text):
                sensitive.append((m.start(), m.end()))
                if kind == "rrn":
                    rrn_hits += 1
                else:
                    lic_hits += 1
        for s, e in sensitive:
            toks = {owner[j] for j in range(s, e) if owner[j] is not None}
            for k in toks:
                _, x, y, w, h = words[k]
                draw.rectangle([x - 6, y - 6, x + w + 6, y + h + 6], fill="black")
        for m in ACCOUNT.finditer(text):
            if any(s <= m.start() < e for s, e in sensitive):
                continue
            digits = re.sub(r"\D", "", m.group())
            if 10 <= len(digits) <= 16:
                accounts.append(re.sub(r"\s", "", m.group()))
    id_card = bool(id_hits & set(ID_STRONG)) or (rrn_hits > 0 and len(id_hits) > 0)
    norm = lambda a: re.sub(r"\D", "", a)
    found = {norm(a) for a in accounts}
    matched = [e for e in expected if norm(e) in found]
    safe = (not id_card) and rrn_hits == 0 and lic_hits == 0 and bool(expected) and len(matched) == len(expected)
    out = os.path.join(outdir, "masked_" + os.path.splitext(os.path.basename(src))[0] + ".png")
    img.save(out)
    print(json.dumps({
        "source": os.path.basename(src),
        "masked_image": out,
        "rrn_masked": rrn_hits,
        "license_no_masked": lic_hits,
        "id_card_suspected": id_card,
        "id_keywords": sorted(id_hits),
        "account_candidates": sorted(set(accounts)),
        "expected_accounts_matched": matched,
        "safe_to_view": safe,
        "policy": "가린 사본 열람 가능" if safe else "이미지 열지 말 것 - 직접 대조 필요로 보고",
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
