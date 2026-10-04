/** 만화 글꼴 — 처음 쓸 때 받아(`backend/comicfonts.py`) 화면에 싣는다 (설계 `docs/comic-editor-design.md` 9-3번).
 *
 *  ★만화 페이지 캔버스가 있을 때만 받는다 — 만화 기능을 안 쓰는 사람은 받지 않는다.
 *  ★받는 동안에도 편집은 된다. 그동안 말풍선·효과음은 앱에 있는 글꼴로 그려지고, 다 싣고 나면 **다시 굽는다**
 *    (글자 레이어가 켤 때 다시 굽는 것과 같은 자리 — `store.refreshGlyphs`).
 *  ★화면은 백엔드가 주는 주소로 `FontFace` 를 만들어 싣는다. 목록(`fonts.json`)의 family 이름이 곧 CSS 글꼴 이름이다. */
import { create } from "zustand";
import { api, backendUrl } from "../lib/backend";
import { forgetGlyphs } from "./pixels";

export type ComicFont = {
  id: string;
  family: string;
  label: string;
  file: string;
  category: "sfx" | "text";
  langs: string[];
  adult?: boolean;
  weight?: number;
  license: string;
};

type Status = { ready: boolean; version: number; fonts: ComicFont[]; downloading: boolean; got: number; total: number; error: string };

type S = {
  status: Status | null;
  /** 실은 판 — 0 이면 아직 */
  loaded: number;
  /** 받기를 시작했나 (한 번만) */
  started: boolean;
};

export const useComicFonts = create<S>(() => ({ status: null, loaded: 0, started: false }));

/** CSS 글꼴 목록 값 — 따옴표로 싼 family (고르기 칸의 값) */
export const stackOf = (f: ComicFont) => `'${f.family}'`;

let onLoaded: (() => void) | null = null;
/** 글꼴을 다 싣고 나면 부를 것 — 스토어가 말풍선·효과음을 다시 굽는다 (순환 import 를 피해 여기 매단다) */
export const whenFontsLoad = (fn: () => void) => {
  onLoaded = fn;
};

async function load(st: Status) {
  const base = await backendUrl();
  const faces = st.fonts.map((f) => {
    const url = `${base}/api/comic-fonts/file/${f.file.split("/").map(encodeURIComponent).join("/")}`;
    const face = new FontFace(f.family, `url("${url}")`, { weight: String(f.weight ?? 400), display: "swap" });
    document.fonts.add(face);
    return face.load().catch((e) => console.warn(`[만화 글꼴] ${f.family} 를 못 실었다`, e));
  });
  await Promise.all(faces);
  forgetGlyphs();
  useComicFonts.setState({ loaded: st.version });
  onLoaded?.();
}

/** 받기에 실패했을 때 다시 — 한 번만 도는 표식을 풀고 다시 부른다 */
export function retryComicFonts(): Promise<void> {
  useComicFonts.setState({ started: false });
  return ensureComicFonts();
}

/** 만화 페이지 캔버스가 있으면 부른다 — 없거나 판이 올랐으면 받고, 받아 둔 것을 싣는다 (여러 번 불러도 한 번만 돈다) */
export async function ensureComicFonts(): Promise<void> {
  if (useComicFonts.getState().started) return;
  useComicFonts.setState({ started: true });
  try {
    let st = await api<Status>("/api/comic-fonts/ensure", { method: "POST" });
    useComicFonts.setState({ status: st });
    // 받아 둔 것이 있으면 먼저 싣는다 (새 판을 받는 동안에도 쓸 수 있게)
    if (st.ready) await load(st);
    while (st.downloading) {
      await new Promise((r) => setTimeout(r, 800));
      st = await api<Status>("/api/comic-fonts");
      useComicFonts.setState({ status: st });
    }
    if (st.ready && st.version !== useComicFonts.getState().loaded) await load(st);
  } catch (e) {
    console.warn("[만화 글꼴] 받지 못했다", e);
    useComicFonts.setState({ status: { ready: false, version: 0, fonts: [], downloading: false, got: 0, total: 0, error: String(e) } });
  }
}
