"""썸네일 — 원본과 화면 사이의 **유일한** 중간층.

배너·카드 앞면·덱 커버가 저마다 그림 바이트를 따로 들고 있던 것을 하나로 합쳤다
(사용자 결정, 2026-08-02: "썸네일은 모두 동일한 이미지를 쓰면 좋을듯").

    원본        outputs/<ws>/work/.../<name>.png   생성물 전량. 큰 화면·라이트박스·내보내기
    파생 썸네일  outputs/<ws>/.thumbs/<flat>.webp   원본에서 자동으로. 히스토리 줄·셀 그리드
    고정 썸네일  data/thumbs/<tid>.webp             꽂은 그림. 배너·카드 앞면·덱 커버가 **참조**

## 왜 층이 둘인가

**파생은 캐시다.** 지워도 다시 만들어진다 (원본이 더 새로우면 다시 굽는다).
PeroPixfy 의 `get_thumbnail_path` 와 같은 방식이고, 히스토리 줄이 832×1216 PNG 를
56×76 으로 줄여 그리던 낭비를 없애는 것이 목적이다.

**고정은 캐시가 아니다.** 원본이 사라져도 남아야 한다 — 카드는 워크스페이스를 넘나드는
공용 저장소라, 워크스페이스를 통째로 지워도 카드 그림은 살아 있어야 한다.
그래서 **꽂는 순간 한 번 복사**한다. 복사는 이 한 번뿐이고, 배너·앞면·커버는 전부
같은 `tid` 를 가리킨다. 예전처럼 목적지마다 따로 굽지 않는다.

## ★tid 는 내용에서 나온다 — 그래서 캐시 문제가 사라진다

`tid = sha1(ws/파일/mtime/크기)`. 같은 그림을 두 곳에 꽂으면 **같은 파일 하나**를 쓰고,
다른 그림을 꽂으면 tid 가 달라지므로 **주소가 달라진다.**
"위치는 그대로 두고 그림만 갈아 끼웠더니 브라우저가 옛 그림을 계속 쓰더라"는 실사용
결함(2026-08-02)이 구조적으로 불가능해진다 — `rev` 같은 판 번호가 필요 없다.

## ★크기는 하나뿐이다

512(긴 변). 히스토리 줄(56×76)에는 넉넉하고, 덱 커버를 최대 배율(3배)로 당겨도 견디는
최소치다. 줄에 수십 장이 뜰 때의 메모리는 **파일을 더 만들지 말고** 지연 로딩으로 푼다.
"""
from __future__ import annotations

import hashlib
import io
import re
from pathlib import Path

# 긴 변 기준. 아래로 내리면 덱 커버 확대에서 뭉개지고, 올리면 히스토리 줄이 무거워진다.
MAX_SIDE = 512
QUALITY = 82

_TID_OK = re.compile(r"^t[0-9a-f]{16}$")


def derive(src: Path, dst: Path) -> Path | None:
    """원본 → 축소 WebP. 이미 최신이면 굽지 않는다. 원본이 없으면 None."""
    if not src.exists():
        return None
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return dst

    from PIL import Image

    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        # 임시 파일에 쓴 뒤 교체 — 굽는 중에 다른 요청이 반쪽 파일을 읽지 않게
        tmp = dst.with_suffix(".tmp")
        im.save(tmp, "WEBP", quality=QUALITY, method=4)
    tmp.replace(dst)
    return dst


def flat_name(rel: str) -> str:
    """워크스페이스 안의 상대 경로 → 파일명 하나. 폴더 구조를 평평하게 눕힌다."""
    return re.sub(r"[\\/]", "_", rel) + ".webp"


class Pins:
    """고정 썸네일 저장소 — 배너·카드·커버가 공유하는 **하나의** 그림 창고."""

    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def tid_of(key: str) -> str:
        return "t" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]

    def path(self, tid: str) -> Path | None:
        if not _TID_OK.match(tid):
            return None  # 외부에서 온 값이 경로가 되지 않게
        p = self.root / f"{tid}.webp"
        return p if p.exists() else None

    def pin(self, src: Path, key: str) -> str | None:
        """원본을 고정 썸네일로 굳히고 tid 를 돌려준다.

        `key` 는 tid 를 정하는 재료다 — 같은 그림이면 같은 tid 가 나와 파일이 하나로 모인다.
        """
        if not src.exists():
            return None
        st = src.stat()
        tid = self.tid_of(f"{key}|{st.st_mtime_ns}|{st.st_size}")
        dst = self.root / f"{tid}.webp"
        if dst.exists():
            return tid
        return tid if derive(src, dst) else None

    def pin_bytes(self, raw: bytes) -> str | None:
        """파일이 없는 그림(저장하지 않은 그림)을 고정 썸네일로 굳힌다. tid 는 **내용**에서 — 같은 그림이면 같은 tid."""
        tid = self.tid_of("bytes|" + hashlib.sha1(raw).hexdigest())
        dst = self.root / f"{tid}.webp"
        if dst.exists():
            return tid
        from PIL import Image

        try:
            with Image.open(io.BytesIO(raw)) as im:
                im.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmp = dst.with_suffix(".tmp")
                im.save(tmp, "WEBP", quality=QUALITY, method=4)
            tmp.replace(dst)
        except Exception:
            return None
        return tid
