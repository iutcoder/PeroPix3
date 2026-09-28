/** 만화 페이지 캔버스 — **순수 계산** (DOM 없음). 용지·컷(다각형 자르기·읽는 차례·붙기)·말풍선 도형.
 *  설계는 `docs/comic-editor-design.md`, 목업은 `docs/comic-editor-mockup.html` (도형 셈은 목업의 것을 그대로 옮겼다).
 *  픽셀로 굽는 것은 `pixels.ts` 의 `bakePanel`·`bakeBubble`, 상태는 `store.ts` 다.
 *  ★판정: `node --experimental-strip-types src/editor/comic.test.ts` */
import type { Rect, Size, TextStyle } from "./model";
import type { Block } from "../lib/blocks";
import type { Thumb } from "../store/prompt";
import type { GenParams } from "../store/gen";
import { STYLE_OPT_KEYS } from "../lib/styleOpts.ts";
import { MODELS } from "../lib/naiModels.ts";

export type Pt = [number, number];
export type Dir = "rtl" | "ltr";

/* ── 용지 ─────────────────────────────────────────────────────── */

/** 만화 캔버스의 속성 — 캔버스(`Doc.comic`)가 든다. 만화 한 편에 한 벌이고 모든 페이지가 같이 쓴다.
 *  컷 간격·테두리는 캔버스 값이다 (옵션 줄의 컷 도구가 고친다) */
export type ComicMeta = {
  /** 읽는 방향 — 페이지 **안의** 컷 차례에만 걸린다. 페이지끼리는 언제나 위에서 아래다 (설계 3번) */
  dir: Dir;
  /** 안쪽 여백(기본 틀). 컷 템플릿은 이 안을 나눈다. 안내선으로만 보이고 저장 그림에는 안 들어간다 */
  frame: Rect;
  /** 컷 사이 간격 — 좌우로 붙은 컷 사이(가로) · 위아래로 붙은 컷 사이(세로) */
  gapX: number;
  gapY: number;
  /** 컷 테두리 두께·색 */
  border: number;
  color: string;
  /** 안내선을 보이나 */
  guides: boolean;
  /** ★★페이지 차례 — 위에서 아래로 (사용자 지시 2026-09-28: 만화 한 편 = 캔버스 하나에 페이지 여럿).
   *  레이어는 `page` 로 제 페이지를 가리키고, 좌표는 **그 페이지 안**의 것이다. 페이지는 모두 캔버스 크기(`Doc.w`·`Doc.h`)다 */
  pages: string[];
  /** 공통 — 화풍 · 캐릭터 카드 · 배경. 모든 페이지 · 모든 컷이 가져다 쓴다 (설계 8-1) */
  common: ComicCommon;
};

/* ── 공통 (설계 8-1) ────────────────────────────────────────────── */

/** 베이스 프롬프트 카드의 머리 — 이름과 배너 그림 (생성 모드의 스타일 카드와 같은 것) */
export type ComicStyle = { ref: string | null; name: string; thumb: Thumb | null };
/** 캐릭터 카드 — 외형. ★캔버스에 한 벌뿐이라 카드 하나가 곧 인물 하나다 (같은 인물인지 따로 판단하지 않는다) */
export type ComicChar = { id: string; ref: string | null; name: string; thumb: Thumb | null; prompt: Block[]; uc: Block[] };
/** 공통 — 베이스(화풍) · UC · 캐릭터 카드 · 배경. 배경은 **블록 하나가 배경 하나**다 (이름 = 블록 이름, 태그 = 배경 프롬프트) */
export type ComicCommon = { style: ComicStyle; base: Block[]; uc: Block[]; chars: ComicChar[]; bgs: Block[] };

/** 캔버스가 드는 생성 옵션 (사용자 결정 2026-09-28: 캔버스마다 따로). 「공통」에 보이는 것 전부다:
 *  생성 옵션 일곱과 프롬프트 옵션 띠의 넷(`STYLE_OPT_KEYS`), 시드와 시드 모드.
 *  ★해상도는 컷 모양이 정하고 저장 옵션은 생성 모드 것을 쓴다 (`cutGen.cutParams`).
 *  ★캔버스를 만들 때 생성 모드의 지금 값을 복사한다. 그 뒤로는 서로 안 따라간다 */
export const COMIC_GEN_KEYS = [...STYLE_OPT_KEYS, "seed", "seed_mode"] as const;
export type ComicGen = Pick<GenParams, (typeof COMIC_GEN_KEYS)[number]>;

/** 남긴 값에서 캔버스의 생성 옵션을 읽는다. 없는 열쇠와 타입이 다른 값은 `from`(생성 모드의 지금 값)으로 채운다.
 *  ★목록에서 사라진 모델도 `from` 의 것으로 (화면은 목록의 값을 보이는데 보내는 값이 옛 모델이면 둘이 어긋난다. `store/gen` 의 `loadParams` 와 같은 규칙) */
export function comicGenOf(raw: unknown, from: GenParams): ComicGen {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of COMIC_GEN_KEYS) out[k] = typeof src[k] === typeof from[k] ? src[k] : from[k];
  if (!MODELS.some(([id]) => id === out.model)) out.model = from.model;
  return out as ComicGen;
}

/** 인물 없는 칸·내레이션·말풍선의 점 — 무채색 (`plugins/manga-maker/web/app.js` 의 `CAST_NEUTRAL`) */
export const CAST_NEUTRAL = "#78859a";

/** 판형 — 세로형 만화 원고 (mm). 웹 게시 세로는 픽셀로 정한다 */
export const PAPERS = {
  a4: { mm: [210, 297] as const },
  b5: { mm: [182, 257] as const },
  b4: { mm: [257, 364] as const },
  web: { px: [1080, 1528] as const },
} as const;
export type PaperId = keyof typeof PAPERS | "custom";
/** 해상도 — 보통 200dpi (반쪽 폭 컷에 생성 그림이 확대 없이 들어간다) · 인쇄 300dpi (설계 3번) */
export type Dpi = 200 | 300;

/** 판형 × 해상도 → 픽셀. A4 보통 = 1654×2339 (설계 13번) */
export function paperPx(id: Exclude<PaperId, "custom">, dpi: Dpi): Size {
  const p = PAPERS[id];
  if ("px" in p) return { w: p.px[0], h: p.px[1] };
  return { w: Math.round((p.mm[0] / 25.4) * dpi), h: Math.round((p.mm[1] / 25.4) * dpi) };
}

/** 새 만화 캔버스의 페이지 값 — 여백·간격·테두리는 A4 보통(폭 1654)을 기준으로 폭에 비례한다 (목업 ③: 가로 24 · 세로 36 · 테두리 3) */
export function newPage(size: Size, dir: Dir): Omit<ComicMeta, "pages" | "common"> {
  const k = size.w / 1654;
  const mx = Math.round(size.w * 0.0575);
  const my = Math.round(size.h * 0.047);
  return {
    dir,
    frame: { x: mx, y: my, w: size.w - mx * 2, h: size.h - my * 2 },
    gapX: Math.max(2, Math.round(24 * k)),
    gapY: Math.max(2, Math.round(36 * k)),
    border: Math.max(1, Math.round(5 * k)),
    color: "#111111",
    guides: true,
  };
}

/* ── 페이지 ──────────────────────────────────────────────────── */

/** 그 레이어가 든 페이지 — 모르는 페이지(없어진 페이지·페이지가 없던 옛 저장본)면 **첫 페이지**다.
 *  ★페이지를 가리는 자리는 전부 이것 하나를 지난다 (무대 · 레이어 목록 · 차례 · 컷 번호) — 따로 거르면 한쪽에서만 레이어가 사라진다 */
export const pageOfLayer = (l: { page?: string }, pages: string[]): string => (l.page && pages.includes(l.page) ? l.page : pages[0]);
/** 그 페이지의 레이어 (차례 그대로) */
export const pageLayers = <T extends { page?: string }>(layers: T[], pages: string[], pid: string): T[] => layers.filter((l) => pageOfLayer(l, pages) === pid);
/** 페이지 이름 — `p.01` (목업의 페이지 머리 · 컷 줄 · 레이어 묶음이 같은 이름) */
export const pageLabel = (i: number) => `p.${String(i + 1).padStart(2, "0")}`;

/** 첫 배치 — 빈 페이지 + 만화 제작기와 같은 11가지 (`plugins/manga-maker/core.py` 의 `LAYOUTS`).
 *  ★앱은 플러그인을 담지 않으므로 표는 **앱 것**이다 (설계 5번). 값은 기본 틀 안의 비율 (x, y, w, h) */
export const LAYOUTS: Record<string, [number, number, number, number][]> = {
  blank: [],
  single: [[0, 0, 1, 1]],
  "two-rows": [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
  "three-rows": [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]],
  "four-grid": [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  "four-rows": [0, 1, 2, 3].map((i) => [0, i / 4, 1, 0.25] as [number, number, number, number]),
  "hero-top": [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  "hero-bottom": [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 1, 0.5]],
  "six-grid": [0, 1, 2].flatMap((y) => [0, 1].map((x) => [x / 2, y / 3, 0.5, 1 / 3] as [number, number, number, number])),
  "two-cols": [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  "tall-left": [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  "tall-right": [[0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0, 0.5, 1]],
};

/** 템플릿 → 컷 다각형들 (문서 좌표). 이웃한 변 사이에만 간격을 준다 (바깥 변은 기본 틀에 붙는다) */
export function templatePanels(page: Pick<ComicMeta, "frame" | "gapX" | "gapY">, key: string): Pt[][] {
  return (LAYOUTS[key] ?? []).map((r) => framePanel(page, r));
}

/** 기본 틀 안의 비율 상자(x, y, w, h — 0~1) → 컷 다각형 (문서 좌표). 이웃한 변 사이에만 간격의 반씩 들인다 (바깥 변은 기본 틀에 붙는다).
 *  ★템플릿과 AI 콘티(`add_comic_page` 의 컷 상자)가 같은 셈을 쓴다 — 둘이 다르면 같은 배치가 다른 모양이 된다 */
export function framePanel(page: Pick<ComicMeta, "frame" | "gapX" | "gapY">, [x, y, w, h]: [number, number, number, number]): Pt[] {
  const f = page.frame;
  const E = 1e-6;
  const x0 = f.x + x * f.w + (x > E ? page.gapX / 2 : 0);
  const x1 = f.x + (x + w) * f.w - (x + w < 1 - E ? page.gapX / 2 : 0);
  const y0 = f.y + y * f.h + (y > E ? page.gapY / 2 : 0);
  const y1 = f.y + (y + h) * f.h - (y + h < 1 - E ? page.gapY / 2 : 0);
  return rectPts({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

export const rectPts = (r: Rect): Pt[] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];

/* ── 컷 (다각형) ─────────────────────────────────────────────── */

/** 컷 레이어가 드는 것 — 꼭짓점은 **레이어 상자 안의 비율**(0~1)이다. 그래서 선택 도구로 옮기고 늘려도 모양이 따라간다.
 *  테두리 두께·색은 캔버스 값(`ComicMeta`)이고 컷은 「테두리 없음」만 따로 든다 */
export type PanelMeta = { pts: Pt[]; noBorder: boolean; gen?: PanelGen };

/* ── 컷 생성 (설계 8번) ─────────────────────────────────────────── */

/** 컷의 캐릭터 프롬프트 한 칸 — 인물(`who` = 공통의 캐릭터 카드 id) · 내레이션 · 말풍선.
 *  ★같은 인물을 한 컷에 여러 번 넣을 수 있다 (사용자 지시 2026-09-28) — 그래서 칸마다 `key` 가 따로 있다.
 *  자리(`x`·`y`)는 **컷 상자 안의 비율**(0~1), `blocks` 는 그 컷에서만 붙는 칩 (블록 하나, 씬 칸과 같다) */
export type CutCast = { key: string; who: string; x: number; y: number; blocks: Block[] };
/** 캐릭터 카드가 아닌 칸 — 내레이션 · 말풍선. 인물과 **같은 칩 입력**이다 (사용자 지시 2026-09-28) */
export const WHO_NARRATION = "@narration";
export const WHO_BUBBLE = "@bubble";
/** 내레이션 · 말풍선을 넣을 때 미리 들어가는 칩 — 그릴 글은 그 뒤에 따옴표로 적는다 (만화 제작기가 내레이션 상자를 넣는 방식, `core.py` 의 `narration box`) */
export const WHO_PRESET: Record<string, string> = { [WHO_NARRATION]: "no humans, narration box", [WHO_BUBBLE]: "no humans, speech bubble" };
/** 그 컷에서 뽑은 그림 — 워크스페이스 파일 (`ws` 의 `file`). 파일이라 지워지지 않는다 */
export type CutTake = { ws: string; file: string };
/** 컷 하나가 곧 씬 하나다 — 그 컷에만 있는 것 (설계 8-1): 장면 요약(프롬프트에 안 들어가는 메모) · 배경(공통의 배경 블록 id) ·
 *  컷 태그(씬 칸과 같은 블록 하나) · 캐릭터 프롬프트 · 크게 · 뽑은 후보 */
export type PanelGen = { summary: string; bg: string | null; blocks: Block[]; cast: CutCast[]; big?: boolean; takes: CutTake[] };
/** 컷의 생성 설정 — 빈 칸은 기본값으로 (옛 저장본·새 컷) */
export const genOf = (p: { gen?: Partial<PanelGen> } | undefined): PanelGen => {
  const g = p?.gen ?? {};
  return {
    summary: g.summary ?? "",
    bg: g.bg ?? null,
    blocks: g.blocks ?? [],
    // ★칸 모양이 옛 것(`{ id, x, y }`)이면 거른다 — 만화 기능은 릴리즈 전이라 옮겨 줄 사용자 데이터가 없다
    cast: (g.cast ?? []).filter((c) => !!c && typeof c.who === "string" && typeof c.key === "string").map((c) => ({ ...c, blocks: c.blocks ?? [] })),
    takes: g.takes ?? [],
    ...(g.big ? { big: true } : {}),
  };
};

/** Opus 무료 한도 — `lib/anlas.ts` 의 `FREE_PIXELS` 와 같은 값 (공홈 `eZ`). 순수 계산이라 여기 둔다 */
const FREE_PX = 1048576;

/** 컷 비율에 맞춘 생성 크기 — 64 배수. 기본은 **Opus 무료 한도 안**에서 가장 큰 판, 「크게」면 컷의 실제 픽셀 크기 (설계 8번).
 *  비율이 극단적이어도 한 변이 64 아래로 가지 않는다 */
export function cutSize(box: Size, big = false): Size {
  const aspect = Math.max(0.05, Math.min(20, box.w / Math.max(1, box.h)));
  const a64 = (v: number) => Math.max(64, Math.round(v / 64) * 64);
  let best: Size = { w: 64, h: 64 };
  let bestErr = Infinity;
  for (let w = 64; w <= 4096; w += 64) {
    const h = Math.min(a64(w / aspect), Math.floor(FREE_PX / w / 64) * 64);
    if (h < 64) break;
    const err = Math.abs(Math.log(w / h / aspect));
    const area = w * h;
    // 비율이 3% 안이면 넓은 판을, 아니면 비율이 가까운 판을
    const better = err < 0.03 && bestErr < 0.03 ? area > best.w * best.h : err < bestErr - 1e-9 || (Math.abs(err - bestErr) < 1e-9 && area > best.w * best.h);
    if (better) {
      best = { w, h };
      bestErr = err;
    }
  }
  // 「크게」 — 컷의 실제 픽셀 크기 (인쇄 판처럼 컷이 무료 판보다 클 때 뜻이 있다). 무료 판보다 작으면 무료 판 그대로
  if (big) {
    const real = { w: a64(box.w), h: a64(box.h) };
    if (real.w * real.h > best.w * best.h) return real;
  }
  return best;
}

/** 인물 자리의 기본값 — 컷 안에 고르게 (한 명은 가운데, 여럿은 가로로 나란히) */
export function castSpot(i: number, n: number): { x: number; y: number } {
  return { x: n <= 1 ? 0.5 : 0.2 + (0.6 * i) / (n - 1), y: 0.55 };
}

/** 컷 그림의 캐릭터 좌표 — 컷 안 비율 그대로 (생성 그림이 곧 컷 상자 비율이다). NAI 좌표 범위 안으로 붙든다 */
export const castCenter = (c: { x: number; y: number }) => ({ x: Math.min(0.95, Math.max(0.05, c.x)), y: Math.min(0.95, Math.max(0.05, c.y)) });

/** 만화 캔버스의 컷 생성 묶음 id — 큐의 씬 그룹 자리에 들어간다. 도착한 그림을 이 열쇠로 그 캔버스의 그 컷(`cell_id`)에 넣는다 */
export const comicGroupId = (docId: string) => `comic_${docId}`;
export const docOfGroup = (groupId: string | null | undefined) => (groupId && groupId.startsWith("comic_") ? groupId.slice(6) : null);

export function bboxOf(pts: Pt[]): Rect {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** 문서 좌표 다각형 → 레이어 상자 + 비율 꼭짓점 */
export function toPanel(doc: Pt[]): { box: Rect; pts: Pt[] } {
  const box = bboxOf(doc);
  const w = box.w || 1;
  const h = box.h || 1;
  return { box, pts: doc.map(([x, y]) => [(x - box.x) / w, (y - box.y) / h] as Pt) };
}

/** 레이어 상자 + 비율 꼭짓점 → 문서 좌표 다각형 (컷은 돌리지 않는다) */
export const panelPts = (l: { x: number; y: number; w: number; h: number }, pts: Pt[]): Pt[] =>
  pts.map(([u, v]) => [l.x + u * l.w, l.y + v * l.h] as Pt);

export function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function pointInPoly(pt: { x: number; y: number }, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 점에서 다각형 변까지의 가장 짧은 거리 */
export function distToEdge(pt: { x: number; y: number }, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - ay) * dy) / L));
    best = Math.min(best, Math.hypot(pt.x - (ax + t * dx), pt.y - (ay + t * dy)));
  }
  return best;
}

/** 반평면으로 자른다 (Sutherland–Hodgman 한 변) — `n·p >= c` 쪽만 남긴다 */
function clipHalf(poly: Pt[], n: Pt, c: number): Pt[] {
  const out: Pt[] = [];
  const side = (p: Pt) => n[0] * p[0] + n[1] * p[1] - c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** 선분 a–b 가 다각형에 닿나 (끝점이 안에 있거나 변을 가로지른다) — 자르기선이 지나는 컷을 고른다 */
export function segHitsPoly(a: { x: number; y: number }, b: { x: number; y: number }, poly: Pt[]): boolean {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  const cross = (o: Pt, p: Pt, q: Pt) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const A: Pt = [a.x, a.y];
  const B: Pt = [b.x, b.y];
  for (let i = 0; i < poly.length; i++) {
    const C = poly[i];
    const D = poly[(i + 1) % poly.length];
    if (cross(A, B, C) * cross(A, B, D) < 0 && cross(C, D, A) * cross(C, D, B) < 0) return true;
  }
  return false;
}

/** 자르기선의 간격 — 선이 누운 쪽이면(위아래로 나뉜다) 세로 간격, 선 쪽이면 가로 간격 */
export const gapFor = (a: { x: number; y: number }, b: { x: number; y: number }, gapX: number, gapY: number) =>
  Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? gapY : gapX;

/** 컷을 자르기선(a→b 를 지나는 직선)으로 둘로 나누고 사이에 `gap` 을 둔다 (설계 5번 · 목업 ③).
 *  선이 컷을 안 지나거나 한쪽이 너무 작으면 null. 돌려주는 차례는 [선의 왼쪽(법선 +) , 오른쪽] */
export function splitPoly(poly: Pt[], a: { x: number; y: number }, b: { x: number; y: number }, gap: number): [Pt[], Pt[]] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return null;
  const n: Pt = [-dy / L, dx / L];
  const c = n[0] * a.x + n[1] * a.y;
  const one = clipHalf(poly, n, c + gap / 2);
  const two = clipHalf(poly, [-n[0], -n[1]], -(c - gap / 2));
  const min = polyArea(poly) * 0.01;
  if (one.length < 3 || two.length < 3 || polyArea(one) < min || polyArea(two) < min) return null;
  return [dedupe(one), dedupe(two)];
}

/** 붙어 있는 같은 점을 거둔다 (자를 때 꼭짓점 위를 지나면 생긴다) */
function dedupe(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 0.01) out.push(q);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.01) out.pop();
  return out;
}

/** 읽는 차례 — 만화 제작기의 `core.reading_order` 를 옮겼다. 통째로 위에 있는 컷이 먼저, 높이가 겹치면
 *  오른쪽부터(rtl) · 왼쪽부터(ltr). 그래서 세로로 쌓인 칸은 다 읽고 옆으로 간다. `eps` 는 문서 높이의 2% */
export function readingOrder(boxes: Rect[], dir: Dir, eps = 0): number[] {
  const before = (a: Rect, b: Rect) => {
    if (a.y + a.h <= b.y + eps) return true;
    if (b.y + b.h <= a.y + eps) return false;
    const ax = a.x + a.w / 2;
    const bx = b.x + b.w / 2;
    return dir === "rtl" ? ax > bx : ax < bx;
  };
  const remaining = boxes.map((_, i) => i);
  const order: number[] = [];
  while (remaining.length) {
    const ready = remaining.filter((i) => !remaining.some((j) => j !== i && before(boxes[j], boxes[i])));
    const pool = ready.length ? ready : remaining;
    const key = (i: number) => [boxes[i].y, dir === "rtl" ? -boxes[i].x : boxes[i].x];
    const pick = pool.reduce((p, i) => {
      const [a0, a1] = key(i);
      const [b0, b1] = key(p);
      return a0 < b0 || (a0 === b0 && a1 < b1) ? i : p;
    });
    order.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return order;
}

/** 꼭짓점 붙기 — 가까운 후보 값에 붙인다 (없으면 그대로). 이웃 컷의 변에서 **간격만큼 떨어진 자리**와 기본 틀이 후보다 */
export function snapTo(v: number, cands: number[], tol: number): number {
  let best = v;
  let d = tol;
  for (const c of cands) {
    const e = Math.abs(c - v);
    if (e <= d) {
      d = e;
      best = c;
    }
  }
  return best;
}

/** 꼭짓점을 끌 때의 붙을 자리 — 다른 컷 꼭짓점의 x·y 와 그 ± 간격, 기본 틀의 변 */
export function snapCands(others: Pt[][], page: Pick<ComicMeta, "frame" | "gapX" | "gapY">): { xs: number[]; ys: number[] } {
  const f = page.frame;
  const xs = [f.x, f.x + f.w];
  const ys = [f.y, f.y + f.h];
  for (const poly of others) {
    for (const [x, y] of poly) {
      xs.push(x, x - page.gapX, x + page.gapX);
      ys.push(y, y - page.gapY, y + page.gapY);
    }
  }
  return { xs, ys };
}

/** 컷에 넣는 그림의 자리 — 컷 상자를 **가득 채우게**(가운데 맞춤, 넘치는 쪽은 잘린다) (설계 8번 「넣기」) */
export function coverRect(box: Rect, img: Size): Rect {
  const k = Math.max(box.w / img.w, box.h / img.h);
  const w = img.w * k;
  const h = img.h * k;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/* ── 말풍선 ─────────────────────────────────────────────────── */

export const BUBBLE_KINDS = ["speech", "narration", "shout", "thought", "whisper", "wavy", "phone"] as const;
export type BubbleKind = (typeof BUBBLE_KINDS)[number];

/** 꼬리 — 끝점(문서 좌표)만 사람이 잡는다. 뿌리는 끝점 방향의 외곽 위로 저절로 따라간다 (설계 6번).
 *  `w` 밑동 폭(px) · `bend` 휨(px, 가운데 제어점을 옆으로 민 양) */
export type Tail = { x: number; y: number; w: number; bend: number };

/** 말풍선 레이어가 드는 것. `body` 는 몸통 상자(문서 좌표) — 꼬리는 그 밖으로 나간다.
 *  ★레이어 상자(x·y·w·h)는 몸통 + 꼬리를 다 담는 상자이고 픽셀은 그 크기로 굽는다 */
export type BubbleMeta = TextStyle & {
  kind: BubbleKind;
  value: string;
  body: Rect;
  tails: Tail[];
  /** 세로쓰기 (일본어 원고용) */
  vertical: boolean;
  /** 글에 맞춤(몸통이 글을 따라 커진다) · 풍선에 맞춤(글이 몸통 폭에서 줄을 바꾼다) */
  fit: "text" | "box";
  /** 글과 몸통 사이 여백(px) */
  pad: number;
  /** 줄 간격 (글꼴 크기의 배) */
  lineGap: number;
  /** 선 두께·선 색·채움 색 */
  stroke: number;
  line: string;
  fill: string;
};

/** 몸통 크기 — 글 상자(`tw`×`th`)가 들어가게. 타원 계열은 내접 사각형이 글 상자가 되도록 √2 배 */
export function bodyFor(kind: BubbleKind, tw: number, th: number, pad: number): Size {
  const k = kind === "narration" ? 1 : kind === "shout" ? 1.55 : kind === "thought" ? 1.5 : Math.SQRT2;
  return { w: Math.ceil(tw * k + pad * 2), h: Math.ceil(th * k + pad * 2) };
}

const P = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${P(cx - rx, cy)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${P(cx + rx, cy)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${P(cx - rx, cy)}Z`;
}
export function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M${P(x + r, y)}H${(x + w - r).toFixed(1)}Q${P(x + w, y)} ${P(x + w, y + r)}V${(y + h - r).toFixed(1)}Q${P(x + w, y + h)} ${P(x + w - r, y + h)}H${(x + r).toFixed(1)}Q${P(x, y + h)} ${P(x, y + h - r)}V${(y + r).toFixed(1)}Q${P(x, y)} ${P(x + r, y)}Z`;
}
/** 외침 — 가시 외곽. ★꼬리는 따로 붙이지 않고 끝점 방향에 가장 가까운 바깥 가시를 끝점까지 늘인다 (식자 관례: 꼬리 = 가장 긴 가시) */
export function spikyPath(cx: number, cy: number, rx: number, ry: number, n: number, seed: number, tips: { x: number; y: number }[]): string {
  const r = rng(seed);
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const t = (i / (n * 2)) * Math.PI * 2;
    const k = i % 2 === 0 ? 1.18 + r() * 0.22 : 0.84 + r() * 0.06;
    pts.push([cx + rx * k * Math.cos(t), cy + ry * k * Math.sin(t)]);
  }
  const step = (Math.PI * 2) / (n * 2);
  for (const tip of tips) {
    const a = Math.atan2((tip.y - cy) / ry, (tip.x - cx) / rx);
    const i = (Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (step * 2)) * 2) % (n * 2);
    pts[i] = [tip.x, tip.y];
  }
  return "M" + pts.map((p) => P(p[0], p[1])).join("L") + "Z";
}
function ellipsePts(cx: number, cy: number, rx: number, ry: number, n: number): [number, number][] {
  const a: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    a.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return a;
}
export function cloudPath(cx: number, cy: number, rx: number, ry: number, n: number): string {
  const pts = ellipsePts(cx, cy, rx, ry, n);
  let d = `M${P(pts[0][0], pts[0][1])}`;
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n];
    const q = pts[i - 1];
    const rr = (Math.hypot(p[0] - q[0], p[1] - q[1]) * 0.62).toFixed(1);
    d += `A${rr} ${rr} 0 0 1 ${P(p[0], p[1])}`;
  }
  return d + "Z";
}
export function wavyPath(cx: number, cy: number, rx: number, ry: number, waves: number, amp: number): string {
  let d = "";
  const N = 160;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const k = 1 + amp * Math.sin(t * waves);
    d += (i ? "L" : "M") + P(cx + rx * k * Math.cos(t), cy + ry * k * Math.sin(t));
  }
  return d + "Z";
}
/** 전화·기계음 — 모서리를 비스듬히 깎은 팔각 */
export function angularPath(cx: number, cy: number, rx: number, ry: number): string {
  const c = 0.38;
  return `M${P(cx - rx + rx * c, cy - ry)}L${P(cx + rx - rx * c, cy - ry)}L${P(cx + rx, cy - ry + ry * c)}L${P(cx + rx, cy + ry - ry * c)}L${P(cx + rx - rx * c, cy + ry)}L${P(cx - rx + rx * c, cy + ry)}L${P(cx - rx, cy + ry - ry * c)}L${P(cx - rx, cy - ry + ry * c)}Z`;
}

export type TailGeo = { b1: Pt; b2: Pt; ctl: Pt; tip: Pt };
/** 꼬리의 뿌리·제어점 — 뿌리는 끝점 방향의 외곽 위(타원으로 근사, 조금 안쪽에서 시작해 이음매가 몸통에 묻힌다),
 *  밑동 폭은 각도로, 휨은 가운데 제어점을 옆으로 민다 */
export function tailGeo(cx: number, cy: number, rx: number, ry: number, t: Tail): TailGeo {
  const a = Math.atan2((t.y - cy) / ry, (t.x - cx) / rx);
  const da = t.w / 2 / Math.max(rx, ry, 1);
  const b1: Pt = [cx + rx * 0.9 * Math.cos(a - da), cy + ry * 0.9 * Math.sin(a - da)];
  const b2: Pt = [cx + rx * 0.9 * Math.cos(a + da), cy + ry * 0.9 * Math.sin(a + da)];
  const mx = (cx + rx * Math.cos(a) + t.x) / 2;
  const my = (cy + ry * Math.sin(a) + t.y) / 2;
  const nx = -(t.y - cy);
  const ny = t.x - cx;
  const nl = Math.hypot(nx, ny) || 1;
  return { b1, b2, ctl: [mx + (nx / nl) * t.bend, my + (ny / nl) * t.bend], tip: [t.x, t.y] };
}
export const tailPath = (g: TailGeo) => `M${P(...g.b1)}Q${P(...g.ctl)} ${P(...g.tip)}Q${P(...g.ctl)} ${P(...g.b2)}Z`;
/** 휨 손잡이의 자리 — 2차 곡선의 가운데 (뿌리 가운데 · 제어점 · 끝점) */
export const bendHandle = (g: TailGeo): Pt => {
  const bx = (g.b1[0] + g.b2[0]) / 2;
  const by = (g.b1[1] + g.b2[1]) / 2;
  return [(bx + 2 * g.ctl[0] + g.tip[0]) / 4, (by + 2 * g.ctl[1] + g.tip[1]) / 4];
};
/** 휨 손잡이를 `p` 로 끌었을 때의 휨 값 — 끝점·가운데를 잇는 선에서 옆으로 떨어진 거리의 두 배 (제어점은 곡선 가운데보다 두 배 멀다) */
export function bendFrom(cx: number, cy: number, rx: number, ry: number, t: Tail, p: { x: number; y: number }): number {
  const g = tailGeo(cx, cy, rx, ry, { ...t, bend: 0 });
  const mid = bendHandle(g);
  const nx = -(t.y - cy);
  const ny = t.x - cx;
  const nl = Math.hypot(nx, ny) || 1;
  return (((p.x - mid[0]) * nx + (p.y - mid[1]) * ny) / nl) * 2;
}
/** 전화 꼬리 — 번개 */
export function boltPath(g: TailGeo): string {
  const x1 = (g.b1[0] + g.b2[0]) / 2;
  const y1 = (g.b1[1] + g.b2[1]) / 2;
  const [x2, y2] = g.tip;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const nx = -dy * 0.12;
  const ny = dx * 0.12;
  return `M${P(...g.b1)}L${P(x1 + dx * 0.45 + nx, y1 + dy * 0.45 + ny)}L${P(x1 + dx * 0.5 - nx * 0.2, y1 + dy * 0.5 - ny * 0.2)}L${P(x2, y2)}L${P(x1 + dx * 0.55 - nx, y1 + dy * 0.55 - ny)}L${P(x1 + dx * 0.5 + nx * 0.2, y1 + dy * 0.5 + ny * 0.2)}L${P(...g.b2)}Z`;
}
/** 생각 꼬리 — 끝점 쪽으로 작아지는 원 셋 [cx, cy, r] */
export function thoughtDots(cx: number, cy: number, t: Tail, size: number): [number, number, number][] {
  return [0.55, 0.75, 0.95].map((f, i) => [cx + (t.x - cx) * f, cy + (t.y - cy) * f, Math.max(1.5, size * (0.38 - i * 0.11))]);
}

/** 말풍선 도형 — 선을 먼저 모두 긋고 채움을 선 없이 위에 덮는다 → 몸통과 꼬리가 **한 외곽선**이 된다 (설계 6번).
 *  `paths` 는 몸통·꼬리 경로(채움과 선 둘 다), `dots` 는 생각 꼬리의 원, `dash` 는 속삭임의 점선 */
export function bubbleShape(b: Pick<BubbleMeta, "kind" | "body" | "tails" | "size">): { body: string; tails: string[]; dots: [number, number, number][]; dash: boolean } {
  const { x, y, w, h } = b.body;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const k = b.kind;
  let body: string;
  if (k === "narration") body = roundRectPath(x, y, w, h, Math.min(w, h) * 0.04);
  else if (k === "shout") body = spikyPath(cx, cy, rx * 0.8, ry * 0.8, 13, 7, b.tails);
  else if (k === "thought") body = cloudPath(cx, cy, rx * 0.9, ry * 0.9, 11);
  else if (k === "wavy") body = wavyPath(cx, cy, rx * 0.95, ry * 0.95, 18, 0.045);
  else if (k === "phone") body = angularPath(cx, cy, rx, ry);
  else body = ellipsePath(cx, cy, rx, ry);
  const tails: string[] = [];
  const dots: [number, number, number][] = [];
  if (k !== "narration" && k !== "shout") {
    for (const t of b.tails) {
      if (k === "thought") dots.push(...thoughtDots(cx, cy, t, Math.min(rx, ry)));
      else {
        const g = tailGeo(cx, cy, rx, ry, t);
        tails.push(k === "phone" ? boltPath(g) : tailPath(g));
      }
    }
  }
  return { body, tails, dots, dash: k === "whisper" };
}

/** 꼬리를 가질 수 있는 종류 — 나레이션만 없다 */
export const hasTails = (k: BubbleKind) => k !== "narration";
/** 휨·밑동 폭이 있는 꼬리 — 외침(가시)·생각(원)은 끝점만 */
export const bendable = (k: BubbleKind) => k !== "narration" && k !== "shout" && k !== "thought";

/** 말풍선 레이어 상자 — 몸통(가시·구름이 삐져나오는 만큼 넉넉히)과 꼬리 끝을 다 담는다. 선 두께만큼 더 */
export function bubbleBounds(b: Pick<BubbleMeta, "kind" | "body" | "tails" | "stroke">): Rect {
  const { x, y, w, h } = b.body;
  const grow = b.kind === "shout" ? 0.25 : b.kind === "thought" ? 0.12 : b.kind === "wavy" ? 0.06 : 0.02;
  let x0 = x - w * grow;
  let y0 = y - h * grow;
  let x1 = x + w * (1 + grow);
  let y1 = y + h * (1 + grow);
  if (hasTails(b.kind)) {
    for (const t of b.tails) {
      x0 = Math.min(x0, t.x - t.w);
      y0 = Math.min(y0, t.y - t.w);
      x1 = Math.max(x1, t.x + t.w);
      y1 = Math.max(y1, t.y + t.w);
    }
  }
  const m = b.stroke + 2;
  return { x: Math.floor(x0 - m), y: Math.floor(y0 - m), w: Math.ceil(x1 - x0 + m * 2), h: Math.ceil(y1 - y0 + m * 2) };
}

/** 풍선에 맞춤 — 줄을 폭 안에서 바꾼다 (띄어쓰기에서 먼저, 안 되면 글자에서). `measure` 는 글의 폭 */
export function wrapLines(value: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of value.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (line.trim() && measure(next) > maxW) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
      // 한 낱말이 폭보다 길면 글자에서 자른다
      let cs = [...line];
      while (cs.length > 1 && measure(line) > maxW) {
        let i = cs.length - 1;
        while (i > 1 && measure(cs.slice(0, i).join("")) > maxW) i--;
        out.push(cs.slice(0, i).join(""));
        cs = cs.slice(i);
        line = cs.join("");
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/* ── 레이어 차례 ─────────────────────────────────────────────── */

type Stackable = { id: string; panel?: PanelMeta; bubble?: BubbleMeta; sfx?: unknown; clip?: string; page?: string; x: number; y: number; w: number; h: number };

/** 레이어가 든 묶음 — 레이어 목록의 묶음 머리(그 밖 · 컷 · 효과음 · 말풍선)와 같다 */
export type Tier = "base" | "panel" | "sfx" | "bubble";

/** 레이어마다 든 묶음. 컷·효과음·말풍선은 제 묶음, 컷에 든 그림은 그 컷 묶음이다.
 *  ★그 밖의 레이어(보통 그림·글자)는 **바로 아래에 있는 것의 묶음**을 따른다 (사용자 결정 2026-09-28: 새 레이어를 컷 위·말풍선 위에
 *    둘 수 있게) — 말풍선 바로 위에 두면 말풍선 묶음에 들어 말풍선과 함께 맨 위에 남고, 맨 아래에 두면 용지와 같은 묶음이다.
 *    따로 적어 두는 값이 없으므로 끌어 옮기면 그 자리의 묶음이 곧 그 레이어의 묶음이 된다 */
export function comicTiers<T extends Stackable>(layers: T[]): Map<string, Tier> {
  const ids = new Set(layers.filter((l) => l.panel).map((l) => l.id));
  const out = new Map<string, Tier>();
  let cur: Tier = "base";
  for (const l of layers) {
    const own: Tier | null = l.panel ? "panel" : l.bubble ? "bubble" : l.sfx ? "sfx" : l.clip && ids.has(l.clip) ? "panel" : null;
    if (own) cur = own;
    out.set(l.id, own ?? cur);
  }
  return out;
}

/** 만화 페이지의 레이어 차례 — **아래부터** 그 밖 묶음(용지 등) → 컷마다 [그 컷에 든 그림들, 컷 테두리] → 컷 위에 둔 레이어 →
 *  효과음 묶음 → 말풍선 묶음. 컷 테두리가 그 컷의 그림 위에 오고, 효과음은 컷 테두리 위(컷 밖으로 삐져나가는 것이 흔하다),
 *  말풍선이 맨 위에 온다. 그 밖의 레이어가 어느 묶음인지는 `comicTiers` 가 정한다.
 *  레이어 목록도 이 묶음으로 보인다 (설계 4번). 같은 묶음 안의 차례는 지킨다 — 목록에서 끌어 바꾼 것이 남는다.
 *  ★`pages` 를 주면 **페이지마다** 이 차례로 맞춰 페이지 차례대로 잇는다 (페이지끼리는 겹치지 않으므로 페이지가 곧 가장 큰 묶음이다) */
export function comicStack<T extends Stackable>(layers: T[], pages?: string[]): T[] {
  if (pages?.length) return pages.flatMap((pid) => stackOne(pageLayers(layers, pages, pid)));
  return stackOne(layers);
}
function stackOne<T extends Stackable>(layers: T[]): T[] {
  const tier = comicTiers(layers);
  const panels = layers.filter((l) => l.panel);
  const ids = new Set(panels.map((p) => p.id));
  const inPanel = (l: T) => !l.panel && !l.bubble && !l.sfx && !!l.clip && ids.has(l.clip);
  const free = (l: T) => !l.panel && !l.bubble && !l.sfx && !inPanel(l);
  const freeIn = (g: Tier) => (l: T) => free(l) && tier.get(l.id) === g;
  return [
    ...layers.filter(freeIn("base")),
    ...panels.flatMap((p) => [...layers.filter((l) => inPanel(l) && l.clip === p.id), p]),
    ...layers.filter(freeIn("panel")),
    ...layers.filter((l) => !!l.sfx || freeIn("sfx")(l)),
    ...layers.filter((l) => !!l.bubble || freeIn("bubble")(l)),
  ];
}

/** 컷 번호 — 읽는 차례대로 1부터 (컷 레이어 id → 번호). ★**한 페이지의** 레이어를 준다 (페이지마다 1부터 센다) */
export function panelNumbers<T extends Stackable>(layers: T[], dir: Dir, pageH: number): Map<string, number> {
  const panels = layers.filter((l) => l.panel);
  const order = readingOrder(panels.map((p) => bboxOf(panelPts(p, p.panel!.pts))), dir, pageH * 0.02);
  return new Map(order.map((i, n) => [panels[i].id, n + 1]));
}

/** 한 페이지의 컷 — 읽는 차례대로 */
export function panelsInOrder<T extends Stackable>(layers: T[], dir: Dir, pageH: number): T[] {
  const nums = panelNumbers(layers, dir, pageH);
  return layers.filter((l) => l.panel).sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
}

/** 인물 점 번호 — **페이지 흐름 순서** (사용자 결정 2026-09-23): 컷을 읽는 차례대로, 컷 안에서는 캐릭터 프롬프트 차례대로
 *  한 페이지에서 이어 센다. 열쇠는 `<컷 id>:<칸 key>` */
export function castNumbers<T extends Stackable>(layers: T[], dir: Dir, pageH: number): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const p of panelsInOrder(layers, dir, pageH)) for (const c of genOf(p.panel).cast) out.set(`${p.id}:${c.key}`, ++n);
  return out;
}

/** 새 꼬리 — 몸통 아래 왼쪽(오른쪽부터 읽으면 아래 왼쪽, 왼쪽부터면 아래 오른쪽)으로 몸통 높이의 0.9 배만큼 */
export function defaultTail(body: Rect, dir: Dir, size: number): Tail {
  const s = dir === "rtl" ? -1 : 1;
  return { x: body.x + body.w / 2 + s * body.w * 0.3, y: body.y + body.h + body.h * 0.6, w: Math.max(8, size * 0.55), bend: s * size * 0.3 };
}
