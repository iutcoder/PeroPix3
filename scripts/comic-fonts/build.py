"""만화 편집기가 처음 쓸 때 받는 글꼴 묶음을 만든다 (`docs/comic-editor-design.md` 9-2·9-3번).

sources.json 의 글꼴을 받아 `_dist/comic-fonts/` 에 두 파일을 만든다.
  - comic-fonts-<판>.zip : fonts/<원래 파일 이름> + licenses/<id>.txt
  - fonts.json           : 판 · zip 주소 · 크기 · sha256 · 글꼴 목록 (앱이 먼저 받아 보는 것)
둘 다 GitHub 릴리즈 `comic-fonts` 태그에 올린다 (올리는 것은 이 스크립트가 하지 않는다).

★글꼴 파일은 **받은 그대로** 넣는다. 서브셋·WOFF2 변환은 OFL 에서 수정이라 이름 예약(RFN)이 걸린 글꼴은
  이름을 바꿔야 한다. 그래서 어느 글꼴도 변환하지 않는다.
★다시 돌리면 바이트까지 같은 zip 이 나온다 — 받는 파일은 sources.json 의 sha256 과 맞아야 하고
  (바뀌었으면 멈춘다), zip 안 시각·권한·순서를 고정한다. 판을 올릴 때는 sources.json 의 version 을 올린다.

licenseSource (라이선스 전문을 어디서 꺼내나):
  url            licenseUrl 을 받아 그대로
  zip:<경로>      url 로 받은 zip 안의 그 파일 (licenseEncoding 으로 읽어 UTF-8 로)
  font           글꼴 name 표의 라이선스 설명(nameID 13) — 영어, 그다음 한국어·일본어
  file:<경로>     이 폴더의 파일 — 배포처에 텍스트 파일이 없어 원문 페이지에서 뽑아 둔 것 (파일 머리에 출처)

쓰는 법: python scripts/comic-fonts/build.py [--cache <폴더>]
  --cache 를 주면 받은 파일을 (주소의 sha256 이름으로) 두고 다음에 다시 쓴다.
"""

import argparse
import hashlib
import io
import json
import os
import struct
import sys
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "_dist", "comic-fonts")
RELEASE = "https://github.com/mrm987/PeroPix3/releases/download/comic-fonts/"
UA = "Mozilla/5.0 (PeroPix comic-fonts build)"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
LANG_EN, LANG_KO, LANG_JA = 0x409, 0x412, 0x411


def fetch(url, cache):
    if cache:
        key = os.path.join(cache, hashlib.sha256(url.encode()).hexdigest())
        if os.path.exists(key):
            with open(key, "rb") as f:
                return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if cache:
        with open(key, "wb") as f:
            f.write(data)
    return data


def sfnt_tables(data):
    num = struct.unpack(">H", data[4:6])[0]
    tables = {}
    for i in range(num):
        tag, _, off, length = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
        tables[tag] = (off, length)
    return tables


def font_info(data):
    """name 표의 (platform 3, 언어, nameID) → 글, 그리고 OS/2 usWeightClass."""
    tables = sfnt_tables(data)
    off, _ = tables[b"name"]
    _, count, str_off = struct.unpack(">HHH", data[off: off + 6])
    names = {}
    for i in range(count):
        pid, _, lid, nid, length, o = struct.unpack(">HHHHHH", data[off + 6 + 12 * i: off + 18 + 12 * i])
        if pid != 3:
            continue
        start = off + str_off + o
        names[(lid, nid)] = data[start: start + length].decode("utf-16-be", errors="replace")
    os2, _ = tables[b"OS/2"]
    weight = struct.unpack(">H", data[os2 + 4: os2 + 6])[0]
    return names, weight


def family_of(names):
    """CSS 에 쓸 family — 글꼴 안의 영어 typographic family(16), 없으면 family(1)."""
    return names.get((LANG_EN, 16)) or names.get((LANG_EN, 1))


def license_text(src, raw, font_data, cache):
    how = src["licenseSource"]
    if how == "url":
        text = fetch(src["licenseUrl"], cache).decode(src.get("licenseEncoding", "utf-8"))
    elif how.startswith("zip:"):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            text = z.read(how[4:]).decode(src.get("licenseEncoding", "utf-8"))
    elif how == "font":
        names, _ = font_info(font_data)
        parts = [names[(lang, 13)] for lang in (LANG_EN, LANG_KO, LANG_JA) if (lang, 13) in names]
        if not parts:
            raise SystemExit(f"{src['id']}: 글꼴 name 표에 라이선스 설명(nameID 13)이 없다")
        text = "\n\n".join(parts)
    elif how.startswith("file:"):
        with open(os.path.join(HERE, how[5:]), encoding="utf-8") as f:
            text = f.read()
    else:
        raise SystemExit(f"{src['id']}: licenseSource 를 모른다: {how}")
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return (text.rstrip("\n") + "\n").encode("utf-8")


def add(z, name, data):
    info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 0
    info.external_attr = 0o644 << 16
    z.writestr(info, data, compresslevel=9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", help="받은 파일을 두고 다시 쓸 폴더")
    args = ap.parse_args()
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)

    with open(os.path.join(HERE, "sources.json"), encoding="utf-8") as f:
        src_all = json.load(f)
    version = int(src_all["version"])
    sources = src_all["fonts"]

    ids = [s["id"] for s in sources]
    if len(set(ids)) != len(ids):
        raise SystemExit("sources.json 에 같은 id 가 둘 있다")

    fonts, entries, seen_files = [], [], set()
    for s in sources:
        raw = fetch(s["url"], args.cache)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != s["sha256"]:
            raise SystemExit(f"{s['id']}: 받은 파일이 바뀌었다 (sha256 {digest}) — 원본을 확인하고 sources.json 을 고친다")
        if s.get("zipMember"):
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                data = z.read(s["zipMember"])
            fname = s["zipMember"].rsplit("/", 1)[-1]
        else:
            data = raw
            fname = urllib.parse.unquote(urllib.parse.urlparse(s["url"]).path.rsplit("/", 1)[-1])
        if fname in seen_files:
            raise SystemExit(f"{s['id']}: 파일 이름이 겹친다: {fname}")
        seen_files.add(fname)

        names, weight = font_info(data)
        fam = family_of(names)
        if fam != s["family"]:
            raise SystemExit(f"{s['id']}: family 가 글꼴 안의 이름({fam!r})과 다르다")
        if weight != s["weight"]:
            raise SystemExit(f"{s['id']}: weight 가 글꼴의 usWeightClass({weight})와 다르다")

        lic = license_text(s, raw, data, args.cache)
        entries.append((f"fonts/{fname}", data))
        entries.append((f"licenses/{s['id']}.txt", lic))
        fonts.append({
            "id": s["id"], "family": s["family"], "label": s["label"], "file": f"fonts/{fname}",
            "category": s["category"], "langs": s["langs"], "adult": s["adult"],
            "weight": s["weight"], "license": s["license"],
        })
        print(f"  {s['id']:<20} {fname:<40} {len(data):>10,}  {s['license']}")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in entries:
            add(z, name, data)
    blob = buf.getvalue()

    zip_name = f"comic-fonts-{version}.zip"
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, zip_name), "wb") as f:
        f.write(blob)
    manifest = {
        "version": version,
        "zip": RELEASE + zip_name,
        "size": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "fonts": fonts,
    }
    with open(os.path.join(OUT, "fonts.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{zip_name}  {len(blob):,} bytes  sha256 {manifest['sha256']}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
