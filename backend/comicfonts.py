"""만화 글꼴 — 말풍선 식자·효과음 글꼴을 **처음 쓸 때** 받는다 (설계 `docs/comic-editor-design.md` 9-3번).

★★앱·패치에 넣지 않는다 (사용자 결정 2026-09-23). 만화 페이지 캔버스를 처음 만들 때 한 번 받고,
  판이 바뀌면 목록(`fonts.json`)의 판 번호로 알아 다시 받는다. 만화 기능을 안 쓰는 사람은 받지 않는다.
★두는 곳은 `data/fonts/comic/` — 사용자 데이터 쪽이라 업데이트·전체 판 교체에 안 지워진다.
★받는 곳은 앱 저장소 릴리즈의 `comic-fonts` 태그 (zip 하나 + `fonts.json`). 묶음은 `scripts/comic-fonts/build.py` 가 만든다.
★라이선스 전문은 글꼴 옆(`licenses/`)에 그대로 둔다 (OFL 조건 2).
★내려받기는 태거(`tagger.py`)와 같은 모양이다 — 백그라운드 스레드, `.part` 로 받아 다 받은 뒤 이름을 준다.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import threading
import zipfile
from pathlib import Path

#: 목록 주소 — 시험할 때는 환경 변수로 로컬 파일 경로나 다른 주소를 준다
INDEX_URL = os.environ.get("PEROPIX_COMIC_FONTS_URL") or "https://github.com/mrm987/PeroPix3/releases/download/comic-fonts/fonts.json"

_root: Path | None = None
_lock = threading.Lock()
#: 내려받기 상태 — 백그라운드 스레드가 갱신한다
_dl = {"running": False, "got": 0, "total": 0, "error": "", "latest": 0}


def init(data_dir: Path) -> None:
    global _root
    _root = Path(data_dir) / "fonts" / "comic"


def root() -> Path:
    if _root is None:
        raise RuntimeError("comicfonts.init 을 먼저 불러야 합니다")
    return _root


def installed() -> dict | None:
    """받아 둔 목록 — 없거나 깨졌으면 None"""
    p = root() / "fonts.json"
    if not p.is_file():
        return None
    try:
        got = json.loads(p.read_text("utf-8"))
        if not all((root() / f["file"]).is_file() for f in got.get("fonts", [])):
            return None
        return got
    except Exception:  # noqa: BLE001 — 깨진 목록은 없는 것과 같다
        return None


def status() -> dict:
    have = installed()
    with _lock:
        dl = dict(_dl)
    return {
        "ready": have is not None,
        "version": (have or {}).get("version", 0),
        "fonts": (have or {}).get("fonts", []),
        "downloading": dl["running"],
        "got": dl["got"],
        "total": dl["total"],
        "error": dl["error"],
    }


def _is_http(u: str) -> bool:
    return u.startswith("http://") or u.startswith("https://")


def _read(u: str, progress: bool = False) -> bytes:
    """주소면 받고, 아니면 로컬 파일을 읽는다 (시험용)"""
    if not _is_http(u):
        data = Path(u).read_bytes()
        if progress:
            with _lock:
                _dl["total"] = len(data)
                _dl["got"] = len(data)
        return data
    import httpx

    buf = io.BytesIO()
    with httpx.stream("GET", u, follow_redirects=True, timeout=60) as r:
        r.raise_for_status()
        if progress:
            with _lock:
                _dl["total"] = int(r.headers.get("content-length") or 0)
        for chunk in r.iter_bytes(1 << 20):
            buf.write(chunk)
            if progress:
                with _lock:
                    _dl["got"] += len(chunk)
    return buf.getvalue()


def _resolve(index: str, ref: str) -> str:
    """목록이 적은 zip 자리 — 절대 주소면 그대로, 아니면 목록 옆.
    ★목록이 로컬 파일이고 그 옆에 같은 이름의 zip 이 있으면 그것을 쓴다 — `scripts/comic-fonts/build.py` 가 만든
      `_dist/comic-fonts/fonts.json` 을 그대로 가리켜 릴리즈에 올리기 전에 시험할 수 있게"""
    if not _is_http(index):
        beside = Path(index).parent / ref.replace("\\", "/").rsplit("/", 1)[-1]
        if beside.is_file():
            return str(beside)
    if _is_http(ref) or Path(ref).is_absolute():
        return ref
    if _is_http(index):
        return index.rsplit("/", 1)[0] + "/" + ref
    return str(Path(index).parent / ref)


def ensure() -> dict:
    """없거나 판이 올랐으면 **백그라운드로** 받는다. 목록을 못 읽으면(오프라인) 받아 둔 것을 그대로 쓴다"""
    with _lock:
        if _dl["running"]:
            return status()
        _dl.update(running=True, got=0, total=0, error="")
    threading.Thread(target=_work, daemon=True).start()
    return status()


def _work() -> None:
    try:
        have = installed()
        try:
            index = json.loads(_read(INDEX_URL).decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            # 받아 둔 것이 있으면 오프라인이어도 문제가 아니다 — 없을 때만 오류로 남긴다
            if have is None:
                with _lock:
                    _dl["error"] = f"글꼴 목록을 못 받았습니다: {e}"
            return
        with _lock:
            _dl["latest"] = int(index.get("version", 0))
        if have is not None and int(have.get("version", 0)) >= int(index.get("version", 0)):
            return
        data = _read(_resolve(INDEX_URL, str(index["zip"])), progress=True)
        want = str(index.get("sha256") or "")
        if want and hashlib.sha256(data).hexdigest() != want:
            raise ValueError("받은 글꼴 묶음이 목록과 다릅니다 (sha256)")
        dest = root()
        tmp = dest.with_name("comic.part")
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                name = info.filename.replace("\\", "/")
                if info.is_dir():
                    continue
                # ★zip 안의 경로가 밖으로 새지 않게
                target = (tmp / name).resolve()
                if tmp.resolve() not in target.parents:
                    raise ValueError(f"묶음 안의 경로가 잘못되었습니다: {name}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(info))
        (tmp / "fonts.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), "utf-8")
        # ★다 푼 뒤에 자리를 바꾼다 — 반쯤 푼 판이 남지 않게. 옛 판은 앱이 받은 사본이라 그냥 지운다
        if dest.exists():
            old = dest.with_name("comic.old")
            if old.exists():
                shutil.rmtree(old, ignore_errors=True)
            dest.replace(old)
            shutil.rmtree(old, ignore_errors=True)
        tmp.replace(dest)
    except Exception as e:  # noqa: BLE001 — 사유를 화면까지 전한다
        with _lock:
            _dl["error"] = str(e)
    finally:
        part = root().with_name("comic.part")
        if part.exists():
            shutil.rmtree(part, ignore_errors=True)
        with _lock:
            _dl["running"] = False


def file_path(rel: str) -> Path | None:
    """받아 둔 글꼴 파일 — 폴더 밖으로 새는 경로는 None"""
    base = root().resolve()
    p = (base / rel).resolve()
    if base not in p.parents or not p.is_file():
        return None
    return p
