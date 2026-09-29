/** 이미지 편집 — **상태** (캔버스·레이어·도구·이력). 계산은 `model.ts`, 픽셀은 `pixels.ts`, 남기는 것은 `persist.ts`.
 *
 *  ★★열어 둔 캔버스는 **재실행 뒤에도 남는다** (사용자 지시 2026-09-22): 레이어 픽셀은 `data/editor/<캔버스>/<키>.png`,
 *    나머지는 `state.json`. 바뀔 때마다 1초 뒤 `persist.ts` 가 적고, 앱을 켤 때 `loadDocs` 로 되살린다 (`hydrate`). 이력은 안 남긴다.
 *    다 읽기 전(`hydrated`)에는 적지 않는다 — 빈 상태로 덮어쓰면 남긴 것이 휴지통으로 간다.
 *  ★★한 번의 편집은 `commit` 한 번이다: 직전 상태(크기·레이어 목록·고른 레이어)를 이력에 적고 바꾼다.
 *    레이어 픽셀은 불변이라(`pixels.ts` 머리) 이력이 든 것은 참조뿐이고, 되돌리기는 그 참조를 도로 놓는 것이다.
 *  ★저장 설정(자리·형식)·캔버스 밖 배경·붓(브러시·지우개 따로)·글자 기본값은 **화면 상태**라 `useUi` 에 산다.
 *  ★코드는 「문서」(`Doc`)라 부르고 화면은 「캔버스」라 부른다 (사용자 지시 2026-09-22: 새 문서 → 새 캔버스). */
import { create } from "zustand";
import { t } from "../i18n";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { ask } from "../store/ask";
import type { Dropped } from "../lib/dropImages";
import {
  FILL_COLOR, NO_ADJUST, canvasShift, cropShift, destOf, dirOf, docToLayer, emptyHist, growFor, growsBeyond, hasAdjust, keepAnchor, nextName, placeNew, pushHist,
  redoHist, rotate90 as rot90, saveNameOf, scaleXform, textLayerName, undoHist,
  type Adjust, type Anchor, type Fill, type Hist, type Rect, type TextMeta,
} from "./model";
import { bakeBubble, bakePanel, bakeSfx, bakeStroke, bucketFill, clipOf, cloneCanvas, exportDataUrl, fillAround, fitBubble, makeCanvas, mergeInto, padCanvas, rebakeText, renderText, type Layer, type Stroke } from "./pixels";
import { newSfx, withStyle, type SfxMeta, type SfxStyleId } from "./sfx";
import type { Fx } from "./fx";
import {
  bboxOf, comicGenOf, comicStack, COMIC_GEN_KEYS, coverRect, defaultTail, gapFor, genOf, hasTails, newPage, pageLabel as pageLabelOf, pageLayers, pageOfLayer, panelPts, splitPoly, templatePanels, toPanel,
  framePanel, type BubbleKind, type BubbleMeta, type ComicCommon, type ComicGen, type ComicMeta, type CutTake, type Dir, type PanelGen, type Pt, type Tail,
} from "./comic";
import { useGen } from "../store/gen";
import { makeBlock, type Block } from "../lib/blocks";
import { loadItem, saveImage } from "./io";
import { loadDocs, scheduleFlush } from "./persist";
import { whenFontsLoad } from "./comicFonts";

export type Tool = "select" | "brush" | "eraser" | "bucket" | "text" | "crop" | "pan" | "panel" | "bubble" | "sfx";

type Snap = { w: number; h: number; layers: Layer[]; sel: string[]; comic?: ComicMeta };

/** 새 캔버스 — 만화면 `comic` 에 읽는 방향과 첫 페이지의 배치 (설계 3번 · 목업 ②) */
export type NewDocOpts = { w: number; h: number; comic?: { dir: Dir; layout: string } };

/** AI 콘티가 까는 페이지 한 장 (설계 10-2) — 이름은 이미 id 로 풀려 있다 (`comicAgent` 가 푼다).
 *  컷 상자는 **기본 틀 안의 비율**(x, y, w, h), 말풍선 자리는 **그 컷 상자 안의 비율** */
export type ContiSpec = {
  cuts: { box: [number, number, number, number]; gen: Omit<PanelGen, "takes"> }[];
  bubbles: { cut: number; kind: BubbleKind; text: string; x: number; y: number; tail?: { x: number; y: number } | null }[];
  /** 공통에 새로 더할 배경 (이야기에 필요한 장소가 공통에 없을 때, 설계 10-3) */
  bgs: Block[];
};

export type Doc = {
  id: string;
  /** 탭에 뜨는 이름 — 원본 파일의 줄기, 또는 「새 캔버스 N」 */
  name: string;
  w: number;
  h: number;
  /** ★아래가 먼저다 (0 = 맨 뒤). 화면 목록은 뒤집어 그린다 (위가 앞) */
  layers: Layer[];
  /** 고른 레이어들 — **뒤가 으뜸**(`primaryOf`: 붓·글자 옵션·오른쪽 기둥이 보는 것). 끌어 고르기·Ctrl+클릭으로 여럿 (사용자 지시 2026-09-22) */
  sel: string[];
  /** 첫 그림의 자리 — 저장 자리(하위 output·덮어쓰기)와 파일 이름의 근거. 새 캔버스·떨군 바이트는 null */
  src: { rel?: string; path?: string; name: string } | null;
  hist: Hist<Snap>;
  /** 마지막 저장(또는 열기) 뒤에 손댔나 — 탭의 점과 닫을 때의 물음 */
  dirty: boolean;
  view: { fit: boolean; zoom: number };
  /** 만화 캔버스면 그 속성 (없으면 보통 이미지 캔버스) — 설계 2번 「새 모드가 아니라 캔버스의 한 종류」.
   *  ★만화 한 편 = 캔버스 하나에 페이지 여럿이다 (사용자 지시 2026-09-28). 레이어는 `page` 로 제 페이지를 가리키고,
   *    되돌리기 이력·저장·탭은 캔버스 하나가 통째로 갖는다 (페이지를 늘리고 지우는 것도 되돌리기 한 걸음) */
  comic?: ComicMeta;
  /** 만화 캔버스에서 **지금 페이지** — 새 레이어(글자·말풍선·효과음·붙여 넣은 그림)가 들어가는 곳, 컷 줄이 보이는 곳.
   *  무대의 어느 페이지를 누르면 그 페이지가 된다. 보기 상태라 이력에 없다 (없어진 페이지면 첫 페이지로 읽는다: `curPage`) */
  page?: string;
  /** 만화 캔버스에서 **생성 버튼이 뽑을 컷** — 무대나 컷 줄에서 컷을 고르면 그 컷이 된다. 「공통」을 보는 동안에도 남는다 (설계 8-1) */
  cut?: string | null;
  /** 만화 캔버스의 생성 옵션 (사용자 결정 2026-09-28: 캔버스마다 따로. 모양은 `comic.ComicGen`).
   *  ★이력 밖이다. 시드는 생성할 때마다 바뀌는데 이력 안에 두면 되돌리기가 옛 시드까지 되살린다 (생성 모드에서도 시드·모델은 되돌리기 밖이다) */
  gen?: ComicGen;
};

/** 지금 페이지 — 없어진 페이지(되돌리기로 사라진 것)면 첫 페이지. 보통 캔버스는 null */
export const curPage = (d: Pick<Doc, "comic" | "page">): string | null =>
  d.comic ? (d.page && d.comic.pages.includes(d.page) ? d.page : (d.comic.pages[0] ?? null)) : null;
/** 생성 버튼이 뽑을 컷 — 없어진 컷이면 null */
export const curCut = (d: Pick<Doc, "comic" | "cut" | "layers">): Layer | null =>
  d.comic && d.cut ? (d.layers.find((l) => l.id === d.cut && l.panel) ?? null) : null;
/** 한 페이지만 담은 문서 — 무대의 페이지 하나 · 그 페이지 저장 · 컷 번호가 이것을 본다. 고른 것도 그 페이지 것만 */
export function pageView(d: Doc, pid: string): Doc {
  if (!d.comic) return d;
  const layers = pageLayers(d.layers, d.comic.pages, pid);
  const ids = new Set(layers.map((l) => l.id));
  return { ...d, layers, sel: d.sel.filter((id) => ids.has(id)) };
}
/** 그 레이어의 페이지 (만화 캔버스가 아니면 null) */
export const layerPage = (d: Pick<Doc, "comic">, l: { page?: string }): string | null => (d.comic ? pageOfLayer(l, d.comic.pages) : null);

type S = {
  docs: Doc[];
  cur: string | null;
  tool: Tool;
  ratioLock: boolean;
  /** 자르기 상자 (문서 좌표). 자르기 도구에서 끄는 동안 */
  crop: Rect | null;
  /** 픽셀만 바뀌었을 때 화면이 다시 그리게 — 문서 객체가 안 바뀌는 획 미리보기 뒤 */
  rev: number;
  busy: boolean;
  /** 남겨 둔 캔버스를 다 읽었나 — 그 전에는 화면도 안 그리고(`Editor`) 적지도 않는다(`persist`) */
  hydrated: boolean;
  /** 남겨 둔 캔버스를 되살린다. 이미 시작했으면 그것을 기다린다. 부팅이 백엔드를 확인한 뒤 부른다 (`App`) */
  hydrate: () => Promise<void>;
  /** 글자 도구로 고치는 중인 글자 레이어. `fresh` 는 방금 만든 것 — 빈 채로 끝나면 레이어를 거둔다.
   *  ★치는 글(`value`)은 **여기**에 있다 — 글 상자가 사라지는 경로(도구 바꾸기·캔버스 옮기기·개발 모드의 이중 마운트)가
   *    여럿이라, 화면의 정리 효과가 아니라 스토어의 `endTextEdit` 하나가 마무리한다 (사용자 지적 2026-09-22: 눌러도 안 생겼다) */
  textEdit: { id: string; fresh: boolean; value: string } | null;
  /** 무대가 그 페이지로 가라는 요청 — 「+ 페이지」 · 컷 줄의 페이지 고르기 · AI 콘티가 깐 페이지 (`n` 이 바뀔 때마다 한 번) */
  reveal: { doc: string; page: string; n: number } | null;
  /** AI 콘티가 콘티를 만드는 중인 캔버스 — 그동안 「AI 콘티」 버튼이 잠기고 무대 맨 아래에 「만드는 중」이 선다 (설계 10-2) */
  contiBusy: string | null;
  /** 만화 캔버스 왼쪽 패널이 보이는 것 — 「공통」 또는 컷 편집 (설계 8-1). 컷을 고르면 컷 편집으로 간다 */
  comicView: "common" | "cut";
  setComicView: (v: "common" | "cut") => void;
  /** 컷 생성 장 수 (1~4) — 생성 푸터의 장 수와 같은 쓰임, 만화 캔버스 것 */
  cutCount: number;
  setCutCount: (n: number) => void;

  doc: () => Doc | null;
  layer: () => Layer | null;
  canUndo: () => boolean;
  canRedo: () => boolean;

  openItems: (items: Dropped[], how: "new" | "layer") => Promise<void>;
  newDoc: (o?: NewDocOpts) => void;
  closeDoc: (id: string) => Promise<void>;
  setCur: (id: string) => void;
  setTool: (t: Tool) => void;
  /** 고른 레이어의 보정 — 불투명도와 같은 규칙이다 (`live` 면 이력을 안 적는다, 끌기 전에 `markBefore`) */
  setAdjust: (p: Partial<Adjust>, live?: boolean) => void;
  /** 고른 레이어의 보정을 전부 0 으로 (한 걸음) */
  resetAdjust: () => void;
  /** 고른 레이어의 효과 목록 (건 차례대로) — 비었거나 `null` 이면 뗀다. 보정과 같은 규칙이다 (`live` 면 이력을 안 적는다) */
  setFx: (fx: Fx[] | null, live?: boolean) => void;
  setRatioLock: (v: boolean) => void;
  setView: (v: Partial<Doc["view"]>) => void;

  /** 레이어 하나만 고른다. `null` 이면 선택을 푼다 (선택 도구로 빈 자리를 눌렀을 때) */
  selectLayer: (id: string | null) => void;
  /** 고른 것에 넣거나 뺀다 (Ctrl+클릭). 넣으면 그것이 으뜸이 된다 */
  toggleSelect: (id: string) => void;
  /** 고른 것을 통째로 바꾼다 (끌어 고르기) */
  selectMany: (ids: string[]) => void;
  /** 변형·불투명도를 고친다. `live` 면 이력을 안 적는다 (끄는 중) — 놓을 때 `commit: true` 로 한 번 적는다 */
  patchLayer: (id: string, p: Partial<Layer>, live?: boolean) => void;
  /** 여러 레이어를 한 번에 (고른 것을 함께 끌 때) */
  patchLayers: (ps: Record<string, Partial<Layer>>, live?: boolean) => void;
  /** 끌기 시작 전의 상태를 이력에 적어 둔다 (live 패치가 그 위에 쌓인다) */
  markBefore: () => void;
  addLayer: () => void;
  dupLayer: () => void;
  mergeDown: () => void;
  /** 컷의 「그리기」 레이어를 골라 돌려준다 — 없으면 `make` 일 때 만든다 (그 컷 그림 위, 컷 모양으로 잘린다). 컷이 아니면 null */
  panelDraw: (panelId: string, make: boolean) => Layer | null;
  /** 글자·말풍선·효과음을 보통 그림 레이어로 바꾼다 (원문을 떼어 낸다 — 붓으로 그리기 전에, 한 걸음) */
  rasterize: (id: string) => void;
  /** 레이어를 거둔다 — 주면 그것, 안 주면 **고른 것 전부** (한 걸음). 컷을 거두면 그 컷에 든 그림도 함께 — 그때는 묻는다 */
  removeLayer: (id?: string) => Promise<void>;
  /** 레이어 차례를 통째로 (아래가 먼저인 id 목록). 화면 목록의 끌기(`useReorder`)가 새 차례를 셈해 넘긴다 */
  orderLayers: (ids: string[]) => void;
  toggleLayer: (id: string) => void;
  renameLayer: (id: string, name: string) => void;
  /** 획이 끝났다 — 굽고 한 걸음 적는다 */
  endStroke: (st: Stroke) => void;

  /** 글자 레이어를 그 자리에 만들고(빈 글) 곧바로 고치기 상태로 */
  addText: (at: { x: number; y: number }) => void;
  /** 있는 글자 레이어를 고치기 시작한다 (원문을 글 상자로) */
  beginTextEdit: (id: string) => void;
  /** 글 상자에 친 글 — 반영은 `endTextEdit` 에서 */
  updateTextEdit: (value: string) => void;
  /** 고치기를 끝낸다 — `apply` 면 친 글을 레이어에 굽고(빈 글이면 레이어를 거둔다), 아니면 버린다(방금 만든 것이면 레이어를 거둔다) */
  endTextEdit: (apply: boolean) => void;
  /** 글자 레이어의 원문·글꼴을 고치고 픽셀을 새로 굽는다 (한 걸음). 어느 캔버스에 있든 찾는다. 빈 원문이면 레이어를 거둔다 */
  patchText: (id: string, p: Partial<TextMeta>) => void;
  /** 손잡이·폭 칸으로 늘린 글자 레이어 — 늘린 비율을 **글꼴 크기**로 옮기고 다시 굽는다 (걸음은 안 적는다: 끌기 전에 적혀 있다) */
  settleText: (id: string) => void;
  /** 페인트통 — 고른 레이어에서 누른 자리와 이어진 같은 색을 브러시 색으로 채운다 (한 걸음). 채운 것이 없으면 false */
  fillAt: (at: { x: number; y: number }) => boolean;

  undo: () => void;
  redo: () => void;
  /** 캔버스 크기 — 기준점 쪽은 붙어 있고 반대쪽이 늘거나 준다. `fill` 이 색이면 **넓어진 자리만** 칠한 레이어를 맨 아래에 깐다 */
  setCanvasSize: (w: number, h: number, a: Anchor, fill?: Fill) => void;
  setImageSize: (w: number, h: number) => void;
  setCrop: (r: Rect | null) => void;
  applyCrop: () => void;
  rotate90: () => void;
  flip: (axis: "h" | "v") => void;

  /* ── 만화 캔버스 ── */
  /** 캔버스 값(간격·테두리·색·안내선·읽는 방향)을 고친다 — 테두리가 바뀌면 컷을 다시 굽는다 (한 걸음) */
  setComic: (p: Partial<Omit<ComicMeta, "pages" | "common">>, live?: boolean) => void;
  /** 지금 페이지를 바꾼다 (이력 없이) */
  setPage: (pid: string) => void;
  /** 그 페이지를 지금 페이지로 하고 무대를 그리로 옮긴다 */
  revealPage: (pid: string) => void;
  /** 생성 버튼이 뽑을 컷을 정한다 — 그 컷의 페이지가 지금 페이지가 된다 (이력 없이) */
  setCut: (id: string | null) => void;
  /** 페이지를 하나 늘린다 — `after` 뒤에(없으면 맨 끝), 흰 용지 한 장과 `layout` 배치로. 늘린 페이지가 지금 페이지가 된다 (한 걸음) */
  addPage: (after?: string | null, layout?: string) => string | null;
  /** 페이지를 지운다 — 그 페이지의 레이어가 전부 빠진다. 그림이 든 컷이 있으면 묻는다. 마지막 한 장은 못 지운다 (한 걸음) */
  removePage: (pid: string) => Promise<void>;
  /** 공통(화풍 · 캐릭터 카드 · 배경)을 고친다 (한 걸음, 설계 8-1) */
  patchCommon: (fn: (c: ComicCommon) => ComicCommon) => void;
  /** 만화 캔버스의 생성 옵션 하나를 고친다 (이력 없이, `Doc.gen`). 캔버스가 드는 열쇠(`COMIC_GEN_KEYS`)가 아니면 아무것도 안 한다 */
  setComicGen: <K extends keyof ComicGen>(docId: string, k: K, v: ComicGen[K]) => void;
  /** 캐릭터 카드를 지운다 — 그 인물이 든 컷의 칸도 **같은 걸음에** 뺀다 (되돌리면 둘 다 돌아온다). 컷에 나와 있으면 묻는다 */
  removeComicChar: (id: string) => Promise<void>;
  /** AI 콘티가 페이지 한 장을 깐다 (설계 10-2) — 마지막 페이지 뒤에, 마지막 페이지가 비어 있으면 거기에.
   *  컷 · 컷마다의 생성 설정 · 말풍선 · 새 배경을 **한 걸음**에 (되돌리기 한 번에 그 페이지가 통째로 물러난다). 깐 페이지를 돌려준다 */
  appendConti: (docId: string, spec: ContiSpec) => { page: string; index: number; reused: boolean } | null;
  /** 첫 배치를 다시 편다 — **지금 페이지의** 있던 컷은 거둔다 (그 안의 그림은 컷 밖 레이어로 남는다). 컷에 그림이 있으면 묻는다 */
  applyLayout: (key: string) => Promise<void>;
  /** 컷 하나를 더한다 (문서 좌표 다각형) */
  addPanel: (poly: Pt[]) => void;
  /** 자르기선으로 컷을 둘로 — 사이에 간격. 선이 지나는 컷 **전부**를 한 걸음에 (Clip Studio 의 컷 나누기와 같다). 하나도 못 나누면 false */
  splitPanels: (ids: string[], a: { x: number; y: number }, b: { x: number; y: number }) => boolean;
  /** 컷 모양을 문서 좌표 다각형으로 바꾼다 (꼭짓점 끌기). `live` 면 이력 없이 */
  setPanelPoly: (id: string, poly: Pt[], live?: boolean) => void;
  /** 컷의 「테두리 없음」 */
  setPanelBorder: (id: string, noBorder: boolean) => void;
  /** 그림을 컷에 넣는다 (컷을 가득 채우게) · `null` 이면 컷에서 뺀다 */
  setClip: (id: string, panel: string | null) => void;
  /** 컷 생성 설정(컷 프롬프트·인물·크게)을 고친다. `live` 면 이력 없이 (인물 점을 끄는 중) */
  setPanelGen: (id: string, p: Partial<PanelGen>, live?: boolean) => void;
  /** 뽑은 그림을 그 컷에 넣는다 — 그 컷에서 뽑아 넣은 그림(`take` 가 있는 레이어)을 갈아 끼우고, 없으면 새로 (컷을 가득 채우게).
   *  저장된 그림이면 후보에도 남긴다. 어느 캔버스든 찾는다 (한 걸음) */
  placeTake: (docId: string, panelId: string, take: CutTake | null, cv: HTMLCanvasElement, name: string) => void;
  /** 말풍선을 그 자리에 만들고 곧바로 글을 고친다 */
  addBubble: (at: { x: number; y: number }) => void;
  /** 말풍선의 원문을 고치고 다시 굽는다. `live` 면 이력 없이 (끄는 중) */
  patchBubble: (id: string, p: Partial<BubbleMeta>, live?: boolean) => void;
  /** 효과음을 그 자리에 만든다 (지금 스타일·문구, 설계 7번) */
  addSfx: (at: { x: number; y: number }) => void;
  /** 효과음의 원문을 고치고 다시 굽는다 (가운데는 그 자리). `live` 면 이력 없이 (슬라이더를 끄는 중) */
  patchSfx: (id: string, p: Partial<SfxMeta>, live?: boolean) => void;
  /** 고른 효과음에 스타일을 건다 (글·크기·흔들림 씨앗은 그대로) */
  styleSfx: (id: string, style: SfxStyleId) => void;
  /** 손잡이로 늘린 효과음 — 늘린 비율을 **글자 크기**로 옮기고 다시 굽는다 (글자 레이어의 `settleText` 와 같다) */
  settleSfx: (id: string) => void;
  /** 글꼴을 새로 실었다 — 모든 캔버스의 말풍선·효과음을 다시 굽는다 (이력 없이, `comicFonts`) */
  refreshGlyphs: () => void;
  /** 고른 것들을 함께 옮긴다 (끄는 중, 이력 없이) — 말풍선은 몸통만 옮기고 **꼬리 끝은 제자리**다 (설계 9-1) */
  dragLayers: (start: Layer[], dx: number, dy: number) => void;

  /** 합성해 저장한다. 성공하면 저장된 자리 (만화 캔버스는 페이지마다 한 장씩, 첫 장의 자리) */
  save: () => Promise<{ file: string; name: string } | null>;
  /** 문서 크기 그대로의 PNG data URL (i2i·인페인트·보내기가 받는다) — 만화 캔버스는 **지금 페이지** */
  dataUrl: () => string;
};

let seq = 1;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const DEFAULT_W = 1216;
const DEFAULT_H = 832;

const docOf = (s: S) => s.docs.find((d) => d.id === s.cur) ?? null;
/** 고른 것 가운데 으뜸 — 마지막에 고른 것 */
export const primaryOf = (d: { sel: string[] }): string | null => d.sel[d.sel.length - 1] ?? null;
/** 「아래와 합치기」가 합칠 레이어 — 못 합치면 null (버튼이 꺼진다).
 *  ★말풍선·효과음·글자는 위에서 합칠 수 있다 (합치면 보통 그림이 된다, 사용자 결정 2026-09-28). 컷과, 아래의 말풍선에는 합치지 않는다
 *  (컷 테두리는 페이지 값에서 다시 굽고, 말풍선에 합치면 몸통을 옮길 때 합친 것이 떨어져 나간다) */
export function mergeBelow(d: { layers: Layer[]; sel: string[]; comic?: ComicMeta }): Layer | null {
  const i = d.layers.findIndex((x) => x.id === primaryOf(d));
  if (i <= 0) return null;
  const top = d.layers[i];
  const below = d.layers[i - 1];
  // ★만화 캔버스는 페이지마다 레이어가 잇닿아 있다 — 페이지 맨 아래 레이어의 「아래」는 앞 페이지 것이라 합치지 않는다
  if (d.comic && pageOfLayer(top, d.comic.pages) !== pageOfLayer(below, d.comic.pages)) return null;
  return top.panel || below.panel || below.bubble ? null : below;
}

export const useEditor = create<S>((set, get) => {
  /** 한 걸음 — 직전 상태를 적고 바꾼다 (그 문서에) */
  const commitDoc = (d: Doc, fn: (d: Doc) => Partial<Doc> | null) => {
    const next = fn(d);
    if (!next) return;
    const snap: Snap = { w: d.w, h: d.h, layers: d.layers, sel: d.sel, comic: d.comic };
    // ★만화 캔버스는 레이어 차례를 페이지마다 묶음(그 밖 → 컷마다 [그림, 테두리] → 말풍선)으로 맞춘다 (`comicStack`)
    if (d.comic && next.layers) next.layers = comicStack(next.layers, (next.comic ?? d.comic).pages);
    set((s) => ({
      docs: s.docs.map((x) => (x.id === d.id ? { ...x, ...next, hist: pushHist(x.hist, snap), dirty: true } : x)),
      rev: s.rev + 1,
    }));
  };
  const commit = (fn: (d: Doc) => Partial<Doc> | null) => {
    const d = docOf(get());
    if (d) commitDoc(d, fn);
  };
  const patchDoc = (id: string, p: Partial<Doc>) =>
    set((s) => ({ docs: s.docs.map((x) => (x.id === id ? { ...x, ...p } : x)), rev: s.rev + 1 }));

  const mkLayer = (cv: HTMLCanvasElement, name: string, at: Rect): Layer => ({
    id: newId("l"), name, on: true, opacity: 100, adj: NO_ADJUST, sw: cv.width, sh: cv.height, cv,
    x: at.x, y: at.y, w: at.w, h: at.h, rot: 0, flipH: false, flipV: false,
  });
  const layerName = (d: Doc | { layers: Layer[] }) => nextName(d.layers.map((l) => l.name), (n) => t("editor.layerN", { n }));
  /** 컷 레이어 — 테두리만 구운 캔버스. 이름은 「컷」 + 만든 차례 (화면의 번호는 읽는 차례로 따로 센다). `pid` 는 그 컷이 든 페이지 */
  const mkPanel = (d: { layers: Layer[] }, poly: Pt[], comic: ComicMeta, pid: string, gen?: PanelGen): Layer => {
    const { box, pts } = toPanel(poly);
    const panel = { pts, noBorder: false, ...(gen ? { gen } : {}) };
    return {
      ...mkLayer(bakePanel(panel, box.w, box.h, comic), nextName(d.layers.map((l) => l.name), (n) => t("editor.panelN", { n })), box),
      panel,
      page: pid,
    };
  };
  /** 컷을 지금 상자 크기로 다시 굽는다 (옮기거나 늘렸거나 테두리가 바뀌었을 때) */
  const rebakePanel = (l: Layer, comic: ComicMeta): Layer =>
    l.panel ? { ...l, cv: bakePanel(l.panel, l.w, l.h, comic), sw: Math.max(1, Math.round(l.w)), sh: Math.max(1, Math.round(l.h)) } : l;
  /** 흰 용지 한 장 — 페이지마다 맨 아래에 깔린다 */
  const mkPaper = (w: number, h: number, pid: string): Layer => {
    const cv = makeCanvas(w, h);
    const g = cv.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    return { ...mkLayer(cv, t("editor.paper"), { x: 0, y: 0, w, h }), page: pid };
  };
  /** 새 레이어가 들 페이지 — 기준 레이어가 있으면 그 페이지, 없으면 지금 페이지 (보통 캔버스는 없음) */
  const pageFor = (d: Doc, near?: Layer | null): { page?: string } => {
    if (!d.comic) return {};
    const pid = near ? pageOfLayer(near, d.comic.pages) : curPage(d);
    return pid ? { page: pid } : {};
  };
  /** 말풍선 원문 → 레이어 (몸통을 글에 맞추고 상자·픽셀을 새로) */
  const withBubble = (l: Layer, b: BubbleMeta, hideText = false): Layer => {
    const fb = fitBubble(b);
    const { box, cv } = bakeBubble(fb, hideText);
    return { ...l, bubble: fb, cv, sw: cv.width, sh: cv.height, x: box.x, y: box.y, w: box.w, h: box.h };
  };
  /** 효과음 원문 → 레이어 (가운데를 지키고 상자·픽셀을 새로). 돌림·뒤집기는 레이어 변형이라 그대로 둔다 */
  const withSfx = (l: Layer, m: SfxMeta): Layer => {
    const { cv } = bakeSfx(m);
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    return { ...l, sfx: m, cv, sw: cv.width, sh: cv.height, w: cv.width, h: cv.height, x: cx - cv.width / 2, y: cy - cv.height / 2 };
  };
  /** 말풍선을 옮기고 늘린다 — 몸통은 그대로 옮기고, 꼬리 끝은 `tails` 를 주면 그 값 (끌어 옮길 때는 제자리) */
  const shiftBubble = (b: BubbleMeta, dx: number, dy: number, k = 1, tails?: Tail[]): BubbleMeta => ({
    ...b,
    size: b.size * k,
    pad: b.pad * k,
    body: { x: b.body.x * k + dx, y: b.body.y * k + dy, w: b.body.w * k, h: b.body.h * k },
    tails: tails ?? b.tails.map((q) => ({ ...q, x: q.x * k + dx, y: q.y * k + dy, w: q.w * k, bend: q.bend * k })),
  });
  /** 캔버스 전체가 옮기거나 늘 때 (캔버스 크기·이미지 크기·자르기) — 컷은 다시 굽고 말풍선은 원문을 따라 옮긴다 */
  const moveComic = (d: Doc, layers: Layer[], dx: number, dy: number, k: number): { layers: Layer[]; comic?: ComicMeta } => {
    if (!d.comic) return { layers };
    const c = d.comic;
    const comic: ComicMeta = {
      ...c,
      frame: { x: c.frame.x * k + dx, y: c.frame.y * k + dy, w: c.frame.w * k, h: c.frame.h * k },
      gapX: c.gapX * k, gapY: c.gapY * k, border: Math.max(1, c.border * k),
    };
    return {
      comic,
      // 효과음은 이미 상자가 옮겨졌다 — 크기가 바뀌었으면 글자 크기로 다시 굽는다 (픽셀을 늘리지 않는다)
      layers: layers.map((l) => (l.panel ? rebakePanel(l, comic) : l.bubble ? withBubble(l, shiftBubble(l.bubble, dx, dy, k)) : l.sfx && k !== 1 ? withSfx(l, { ...l.sfx, size: l.sfx.size * k }) : l)),
    };
  };
  /** 새 만화 캔버스 — 첫 페이지 하나 (흰 용지 + 첫 배치의 컷들) */
  const makeComicDoc = (w: number, h: number, dir: Dir, layout: string, name: string): Doc => {
    const pid = newId("pg");
    const common: ComicCommon = {
      style: { ref: null, name: t("editor.comicStyle"), thumb: null },
      base: [makeBlock(t("block.newBlock"), [], { open: true })],
      uc: [],
      chars: [],
      bgs: [],
    };
    const comic: ComicMeta = { ...newPage({ w, h }, dir), pages: [pid], common };
    const layers: Layer[] = [mkPaper(w, h, pid)];
    for (const poly of templatePanels(comic, layout)) layers.push(mkPanel({ layers }, poly, comic, pid));
    // 생성 옵션은 생성 모드의 지금 값을 복사해 시작한다
    const gen = comicGenOf(null, useGen.getState().params);
    return { id: newId("d"), name, w, h, layers, sel: [], src: null, hist: emptyHist(), dirty: false, view: { fit: true, zoom: 1 }, comic, page: pid, cut: null, gen };
  };
  /** 만화 캔버스에서 고른 것이 바뀌었을 때 — 으뜸이 컷이거나 컷에 든 그림이면 그 컷이 **생성 버튼이 뽑을 컷**이 되고,
   *  으뜸의 페이지가 지금 페이지가 된다 (설계 8-1: 무대에서 컷을 누르면 그 컷을 편다). 아무것도 안 골랐으면 그대로 둔다 */
  const focus = (d: Doc, sel: string[]) => {
    const l = d.comic ? d.layers.find((x) => x.id === sel[sel.length - 1]) : undefined;
    if (!d.comic || !l) return patchDoc(d.id, { sel });
    const cut = l.panel ? l.id : l.clip && d.layers.some((x) => x.id === l.clip && x.panel) ? l.clip : undefined;
    patchDoc(d.id, { sel, page: pageOfLayer(l, d.comic.pages), ...(cut ? { cut } : {}) });
    if (cut) set({ comicView: "cut" });
  };
  /** 새 컷의 생성 설정 — 그 컷의 **배경과 인물**을 이어받고, 컷 태그와 인물마다의 칩은 비운다 (설계 8-1) */
  const inherit = (from: Layer): PanelGen => {
    const g = genOf(from.panel);
    return { summary: "", bg: g.bg, blocks: [], cast: g.cast.map((c) => ({ ...c, key: newId("k"), blocks: [] })), takes: [] };
  };
  /** 레이어들을 뺀 목록과 그 뒤의 선택 — 고른 것이 빠졌으면 빠진 자리(맨 아래 것)의 이웃 하나, 아니면 고른 것 그대로 */
  const without = (d: Doc, ids: string[]): Partial<Doc> | null => {
    const gone = d.layers.filter((x) => ids.includes(x.id));
    if (!gone.length) return null;
    const layers = d.layers.filter((x) => !ids.includes(x.id));
    const left = d.sel.filter((id) => !ids.includes(id));
    if (left.length === d.sel.length) return { layers, sel: left };
    const i = d.layers.findIndex((x) => x.id === gone[0].id);
    const next = layers[Math.min(i, layers.length - 1)]?.id;
    return { layers, sel: left.length ? left : next ? [next] : [] };
  };

  // ★남겨 둔 캔버스를 되살린다 (한 번만). 그 전에 연 것(빠르게 보낸 그림)은 뒤에 붙인다
  let hydrating: Promise<void> | null = null;
  const hydrate = () =>
    (hydrating ??= (async () => {
      try {
        const { docs, cur } = await loadDocs();
        set((s) => ({ docs: [...docs, ...s.docs], cur: s.cur ?? (docs.some((d) => d.id === cur) ? cur : (docs[0]?.id ?? null)), hydrated: true }));
      } catch (e) {
        console.warn("[editor] 남겨 둔 캔버스를 못 읽었다", e);
        set({ hydrated: true });
      }
    })());

  return {
    docs: [],
    cur: null,
    tool: "brush",
    ratioLock: true,
    crop: null,
    rev: 0,
    busy: false,
    hydrated: false,
    hydrate,
    textEdit: null,
    reveal: null,
    contiBusy: null,
    comicView: "common",
    setComicView: (v) => set({ comicView: v }),
    cutCount: 1,
    setCutCount: (n) => set({ cutCount: Math.max(1, Math.min(4, Math.round(n))) }),

    doc: () => docOf(get()),
    layer: () => {
      const d = docOf(get());
      return d?.layers.find((l) => l.id === primaryOf(d)) ?? null;
    },
    canUndo: () => (docOf(get())?.hist.past.length ?? 0) > 0,
    canRedo: () => (docOf(get())?.hist.future.length ?? 0) > 0,

    async openItems(items, how) {
      if (!items.length) return;
      set({ busy: true });
      try {
        const loaded: { cv: HTMLCanvasElement; name: string; item: Dropped }[] = [];
        for (const item of items) {
          try {
            const r = await loadItem(item);
            loaded.push({ ...r, item });
          } catch (e) {
            toast(t("editor.openFail", { name: item.name, e: String(e) }), "warn");
          }
        }
        if (!loaded.length) return;
        const cur = docOf(get());
        if (how === "layer" && cur) {
          // ★고른 캔버스 위에 **레이어로** — 큰 그림은 캔버스에 맞춰 줄여 가운데에 놓는다.
          //   만화 페이지에서 컷을 골라 두었으면 **그 컷에 넣는다** (컷을 가득 채우게, 설계 8번 「넣기」)
          commit((d) => {
            const layers = [...d.layers];
            let sel = d.sel;
            const into = d.comic ? d.layers.find((l) => l.id === primaryOf(d) && l.panel) : undefined;
            for (const x of loaded) {
              const img = { w: x.cv.width, h: x.cv.height };
              const at = into?.panel ? coverRect(bboxOf(panelPts(into, into.panel.pts)), img) : placeNew(d, img);
              // ★만화 캔버스는 그 컷의 페이지, 컷을 안 골랐으면 지금 페이지에 든다
              const l: Layer = { ...mkLayer(x.cv, x.name.replace(/\.[^.]+$/, ""), at), ...pageFor(d, into), ...(into ? { clip: into.id } : {}) };
              layers.push(l);
              sel = [l.id];
            }
            return { layers, sel };
          });
          return;
        }
        // ★새 캔버스 하나에 **전부** 넣는다 (사용자 결정 2026-09-22: 여러 장을 보내도 물음은 한 번, 넣는 곳도 한 곳).
        //   크기는 첫 그림이고 나머지는 그 안에 맞춰 놓는다.
        const first = loaded[0];
        const w = first.cv.width;
        const h = first.cv.height;
        const layers: Layer[] = loaded.map((x, i) =>
          mkLayer(x.cv, x.name.replace(/\.[^.]+$/, ""), i === 0 ? { x: 0, y: 0, w, h } : placeNew({ w, h }, { w: x.cv.width, h: x.cv.height })),
        );
        const src = first.item.rel || first.item.path ? { rel: first.item.rel, path: first.item.path, name: first.name } : null;
        const doc: Doc = {
          id: newId("d"), name: first.name.replace(/\.[^.]+$/, ""), w, h, layers,
          sel: [layers[layers.length - 1].id], src, hist: emptyHist(), dirty: false, view: { fit: true, zoom: 1 },
        };
        set((s) => ({ docs: [...s.docs, doc], cur: doc.id, crop: null, textEdit: null }));
      } finally {
        set({ busy: false });
      }
    },

    newDoc(o) {
      const w = o?.w ?? DEFAULT_W;
      const h = o?.h ?? DEFAULT_H;
      const names = get().docs.map((d) => d.name);
      if (!o?.comic) {
        const name = nextName(names, (n) => t("editor.untitledN", { n }));
        const l = mkLayer(makeCanvas(w, h), t("editor.layerN", { n: 1 }), { x: 0, y: 0, w, h });
        const doc: Doc = { id: newId("d"), name, w, h, layers: [l], sel: [l.id], src: null, hist: emptyHist(), dirty: false, view: { fit: true, zoom: 1 } };
        set((s) => ({ docs: [...s.docs, doc], cur: doc.id, crop: null, textEdit: null }));
        return;
      }
      // ★만화 — 첫 페이지 하나 (흰 용지 + 첫 배치의 컷들, 설계 3번 · 5번). 안내선은 화면에만 있다
      const doc = makeComicDoc(w, h, o.comic.dir, o.comic.layout, nextName(names, (n) => t("editor.comicN", { n })));
      // 컷이 있으면 말풍선 도구, 빈 페이지면 컷 도구로 시작한다
      // 왼쪽은 「공통」부터 편다 (고른 컷이 아직 없다)
      set((s) => ({ docs: [...s.docs, doc], cur: doc.id, crop: null, textEdit: null, tool: doc.layers.length > 1 ? "select" : "panel", comicView: "common" }));
    },

    async closeDoc(id) {
      get().endTextEdit(true);
      const d = get().docs.find((x) => x.id === id);
      if (!d) return;
      if (d.dirty && !(await ask({ title: t("editor.unsavedClose", { name: d.name }), body: t("editor.unsavedBody"), ok: t("editor.closeAnyway"), cancel: t("common.cancel"), danger: true })))
        return;
      set((s) => {
        const docs = s.docs.filter((x) => x.id !== id);
        const i = s.docs.findIndex((x) => x.id === id);
        const cur = s.cur === id ? (docs[Math.min(i, docs.length - 1)]?.id ?? null) : s.cur;
        return { docs, cur, crop: null, textEdit: null };
      });
    },

    setCur(id) {
      get().endTextEdit(true);
      const d = get().docs.find((x) => x.id === id);
      // 고른 컷이 없는 만화 캔버스로 가면 「공통」을 편다 (컷 편집에 펼 것이 없다)
      set((s) => ({ cur: id, crop: null, comicView: d?.comic && !d.cut ? "common" : s.comicView }));
    },
    setTool(tool) {
      get().endTextEdit(true);
      set({ tool, crop: tool === "crop" ? get().crop : null });
    },
    setAdjust(p, live = false) {
      const l = get().layer();
      if (!l) return;
      get().patchLayer(l.id, { adj: { ...l.adj, ...p } }, live);
    },
    resetAdjust() {
      const l = get().layer();
      if (!l || !hasAdjust(l.adj)) return;
      get().patchLayer(l.id, { adj: NO_ADJUST });
    },
    setFx(fx, live = false) {
      const l = get().layer();
      if (!l) return;
      get().patchLayer(l.id, { fx: fx?.length ? fx : null }, live);
    },
    setRatioLock: (v) => set({ ratioLock: v }),
    setView(v) {
      const d = docOf(get());
      if (d) patchDoc(d.id, { view: { ...d.view, ...v } });
    },

    selectLayer(id) {
      const d = docOf(get());
      if (!d) return;
      const next = id ? [id] : [];
      if (d.sel.length !== next.length || d.sel[0] !== next[0]) focus(d, next);
    },
    toggleSelect(id) {
      const d = docOf(get());
      if (!d) return;
      focus(d, d.sel.includes(id) ? d.sel.filter((x) => x !== id) : [...d.sel, id]);
    },
    selectMany(ids) {
      const d = docOf(get());
      if (!d) return;
      if (ids.length !== d.sel.length || ids.some((id, i) => d.sel[i] !== id)) focus(d, ids);
    },
    patchLayer(id, p, live = false) {
      get().patchLayers({ [id]: p }, live);
    },
    patchLayers(ps, live = false) {
      const d = docOf(get());
      if (!d) return;
      const layers = d.layers.map((x) => (ps[x.id] ? { ...x, ...ps[x.id] } : x));
      if (live) patchDoc(d.id, { layers, dirty: true });
      else commit(() => ({ layers }));
    },
    markBefore() {
      // ★끌기 전에 한 걸음 적어 두고, 끄는 동안은 live 패치 — 놓을 때 또 적지 않는다
      commit((d) => ({ layers: d.layers }));
    },
    addLayer() {
      commit((d) => {
        const i = d.layers.findIndex((x) => x.id === primaryOf(d));
        // ★고른 것 바로 위에 둔다. 만화 페이지에서 컷에 든 그림을 골라 두었으면 새 레이어도 그 컷에 든다 (그 컷 모양으로 잘린다)
        const at = d.layers[i];
        const clip = d.comic && at && !at.panel && at.clip && d.layers.some((x) => x.id === at.clip && x.panel) ? at.clip : undefined;
        const l: Layer = { ...mkLayer(makeCanvas(d.w, d.h), layerName(d), { x: 0, y: 0, w: d.w, h: d.h }), ...pageFor(d, at), ...(clip ? { clip } : {}) };
        const layers = [...d.layers];
        layers.splice(i < 0 ? layers.length : i + 1, 0, l);
        return { layers, sel: [l.id] };
      });
    },
    dupLayer() {
      commit((d) => {
        const i = d.layers.findIndex((x) => x.id === primaryOf(d));
        if (i < 0) return null;
        const src = d.layers[i];
        const l: Layer = { ...src, id: newId("l"), name: t("editor.copyOf", { name: src.name }), cv: cloneCanvas(src.cv) };
        const layers = [...d.layers];
        layers.splice(i + 1, 0, l);
        return { layers, sel: [l.id] };
      });
    },
    mergeDown() {
      commit((d) => {
        const i = d.layers.findIndex((x) => x.id === primaryOf(d));
        const top = d.layers[i];
        const below = mergeBelow(d);
        if (!top || !below) return null;
        // ★합친 결과는 보통 레이어다 — 아래가 글자 레이어였어도 원문을 떼어 낸다 (남기면 다음 고치기가 합친 것을 지운다).
        //   위가 컷에 든 그림이면 그 컷 모양으로 잘라 넣는다
        //   ★위가 아래 상자 밖으로 나가면 아래를 먼저 넓힌다 — 안 넓히면 밖으로 나간 자리가 잘려 나간다 (사용자 결정 2026-09-28)
        const g = growFor(below, top, d);
        const base: Layer = g ? { ...below, ...g.xform, cv: padCanvas(below.cv, g.pad) } : below;
        const merged: Layer = { ...base, text: undefined, sfx: undefined, cv: mergeInto(base, top, top.clip !== below.clip ? clipOf(d.layers, top) : null) };
        const layers = d.layers.filter((_, k) => k !== i).map((x) => (x.id === below.id ? merged : x));
        return { layers, sel: [below.id] };
      });
    },
    panelDraw(panelId, make) {
      const d = docOf(get());
      const p = d?.layers.find((l) => l.id === panelId && l.panel);
      if (!d || !p?.panel) return null;
      const had = d.layers.find((l) => l.draw && l.clip === panelId);
      if (had) {
        get().selectLayer(had.id);
        return had;
      }
      if (!make) return null;
      // ★컷 상자 크기 그대로 (1:1) — 그 컷의 그림들 위, 테두리 바로 아래에 둔다 (`comicStack` 이 컷 묶음 안의 차례를 지킨다)
      const b = bboxOf(panelPts(p, p.panel.pts));
      const box = { x: Math.floor(b.x), y: Math.floor(b.y), w: Math.max(1, Math.ceil(b.w)), h: Math.max(1, Math.ceil(b.h)) };
      const l: Layer = { ...mkLayer(makeCanvas(box.w, box.h), t("editor.panelDraw"), box), ...pageFor(d, p), clip: panelId, draw: true };
      commit((dd) => {
        const at = dd.layers.findIndex((x) => x.id === panelId);
        const layers = [...dd.layers];
        layers.splice(at < 0 ? layers.length : at, 0, l);
        return { layers, sel: [l.id] };
      });
      return docOf(get())?.layers.find((x) => x.id === l.id) ?? null;
    },
    rasterize(id) {
      if (get().textEdit?.id === id) get().endTextEdit(true);
      commit((d) => {
        const l = d.layers.find((x) => x.id === id);
        if (!l || !(l.text || l.bubble || l.sfx)) return null;
        // 픽셀은 지금 구운 그대로 — 원문만 떼어 낸다. 만화 페이지의 자리는 그대로다 (`comicTiers`: 아래에 있는 것의 묶음을 따른다)
        return { layers: d.layers.map((x) => (x.id === id ? { ...x, text: undefined, bubble: undefined, sfx: undefined } : x)) };
      });
    },
    async removeLayer(id) {
      // ★안 주면 고른 것 **전부** — 여럿을 골라 Del 하면 한 걸음에 다 거둔다 (사용자 지시 2026-09-22)
      let targets = id ? [id] : (get().doc()?.sel ?? []);
      if (!targets.length) return;
      // ★컷을 거두면 그 컷에 든 그림도 함께 — 생성물이 화면에서 사라지므로 묻는다 (데스크 지침 「확인 창」, 설계 5번)
      const d0 = get().docs.find((d) => d.layers.some((l) => targets.includes(l.id)));
      if (d0?.comic) {
        const kids = d0.layers.filter((l) => l.clip && targets.includes(l.clip) && !targets.includes(l.id));
        if (kids.length) {
          const n = d0.layers.filter((l) => l.panel && targets.includes(l.id)).length;
          const ok = await ask({ title: t("editor.panelDelTitle", { n }), body: t("editor.panelDelBody", { m: kids.length }), ok: t("editor.delete"), cancel: t("common.cancel"), danger: true });
          if (!ok) return;
          targets = [...targets, ...kids.map((l) => l.id)];
        }
      }
      const te = get().textEdit;
      if (te && targets.includes(te.id)) set({ textEdit: null });
      commit((d) => without(d, targets));
    },
    orderLayers(ids) {
      commit((d) => {
        if (ids.length !== d.layers.length) return null;
        const by = new Map(d.layers.map((l) => [l.id, l]));
        const layers = ids.map((id) => by.get(id)).filter((l): l is Layer => !!l);
        if (layers.length !== d.layers.length || layers.every((l, i) => l === d.layers[i])) return null;
        return { layers };
      });
    },
    toggleLayer(id) {
      commit((d) => ({ layers: d.layers.map((x) => (x.id === id ? { ...x, on: !x.on } : x)) }));
    },
    renameLayer(id, name) {
      const d = docOf(get());
      if (!d || !name.trim()) return;
      patchDoc(d.id, { layers: d.layers.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)), dirty: true });
    },
    endStroke(st) {
      commit((d) => {
        const l = d.layers.find((x) => x.id === primaryOf(d));
        if (!l) return null;
        return { layers: d.layers.map((x) => (x.id === l.id ? { ...x, cv: bakeStroke(x, st) } : x)) };
      });
    },

    addText(at) {
      const text: TextMeta = { ...useUi.getState().editorText, value: "" };
      let made: string | null = null;
      commit((d) => {
        const cv = renderText(text);
        const l: Layer = {
          ...mkLayer(cv, nextName(d.layers.map((x) => x.name), (n) => t("editor.textN", { n })), { x: Math.round(at.x), y: Math.round(at.y), w: cv.width, h: cv.height }),
          ...pageFor(d),
          text,
        };
        made = l.id;
        const i = d.layers.findIndex((x) => x.id === primaryOf(d));
        const layers = [...d.layers];
        layers.splice(i < 0 ? layers.length : i + 1, 0, l);
        return { layers, sel: [l.id] };
      });
      if (made) set({ textEdit: { id: made, fresh: true, value: "" } });
    },
    beginTextEdit(id) {
      get().endTextEdit(true);
      const l = get().docs.flatMap((d) => d.layers).find((x) => x.id === id);
      if (l?.bubble) {
        // ★말풍선은 고치는 동안 글을 빼고 굽는다 — 글 상자가 그 자리에 뜬다 (글자 레이어를 합성에서 빼는 것과 같은 이유)
        set({ textEdit: { id, fresh: false, value: l.bubble.value } });
        get().patchBubble(id, {}, true);
        return;
      }
      if (!l?.text) return;
      set({ textEdit: { id, fresh: false, value: l.text.value } });
    },
    updateTextEdit(value) {
      const te = get().textEdit;
      if (!te) return;
      set({ textEdit: { ...te, value } });
      // 말풍선은 치는 동안 몸통이 글을 따라 커진다 (글에 맞춤)
      const l = get().docs.flatMap((d) => d.layers).find((x) => x.id === te.id);
      if (l?.bubble) get().patchBubble(te.id, { value }, true);
    },
    endTextEdit(apply) {
      const te = get().textEdit;
      if (!te) return;
      set({ textEdit: null });
      const l = get().docs.flatMap((d) => d.layers).find((x) => x.id === te.id);
      if (l?.bubble) {
        // 방금 만든 것 — 취소했거나 빈 글이면 거둔다. 반영이면 만들 때 적은 걸음에 글까지 한 걸음으로 친다
        if (te.fresh) {
          if (!apply || !te.value.trim()) void get().removeLayer(te.id);
          else get().patchBubble(te.id, { value: te.value }, true);
          return;
        }
        // 있던 것 — 반영은 한 걸음, 취소는 원래 글로 도로 굽는다
        if (apply && te.value !== l.bubble.value) get().patchBubble(te.id, { value: te.value });
        else get().patchBubble(te.id, apply ? { value: te.value } : {}, true);
        return;
      }
      if (!l?.text) return;
      if (!apply) {
        if (te.fresh) void get().removeLayer(te.id);
        return;
      }
      if (te.value !== l.text.value || (te.fresh && !te.value.trim())) get().patchText(te.id, { value: te.value });
    },
    patchText(id, p) {
      const d = get().docs.find((x) => x.layers.some((l) => l.id === id));
      if (!d) return;
      commitDoc(d, (dd) => {
        const l = dd.layers.find((x) => x.id === id);
        if (!l?.text) return null;
        const text: TextMeta = { ...l.text, ...p };
        if (!text.value.trim()) return without(dd, [id]);
        const cv = renderText(text);
        // ★글자 레이어의 상자는 언제나 구운 크기 그대로다 — 늘린 비율은 `settleText` 가 글꼴 크기로 옮겨 두므로 여기서 지킬 배율이 없다.
        //   자리는 닻(정렬 쪽 위 모서리)을 지킨다 — 돌려 둔 글자가 글자를 칠 때마다 밀리지 않게
        const name = "value" in p ? textLayerName(text.value, l.name) : l.name;
        const at = keepAnchor(l, { w: cv.width, h: cv.height }, text.align);
        return {
          layers: dd.layers.map((x) => (x.id === id ? { ...x, text, name, cv, sw: cv.width, sh: cv.height, w: cv.width, h: cv.height, x: at.x, y: at.y } : x)),
        };
      });
    },
    settleText(id) {
      // ★글자 레이어는 픽셀을 확대하지 않는다 (사용자 지적 2026-09-22: 늘리면 글씨가 깨지고, 글자 도구로 열면 원래 크기로 돌아갔다).
      //   상자를 늘린 비율만큼 글꼴 크기를 바꿔 새로 굽고, 가운데는 그 자리에 둔다
      const d = get().docs.find((x) => x.layers.some((l) => l.id === id));
      const l = d?.layers.find((x) => x.id === id);
      if (!d || !l?.text || (l.w === l.sw && l.h === l.sh)) return;
      const p = rebakeText(l);
      if (!p) return;
      patchDoc(d.id, { layers: d.layers.map((x) => (x.id === id ? { ...x, ...p } : x)), dirty: true });
    },
    fillAt(at) {
      const l = get().layer();
      if (!l) return false;
      const ui = useUi.getState().editorBrush;
      const p = docToLayer(l, at.x, at.y);
      const cv = bucketFill(l, p.x, p.y, ui.brush.color, ui.bucket.tolerance);
      if (!cv) return false;
      commit((d) => ({ layers: d.layers.map((x) => (x.id === l.id ? { ...x, cv } : x)) }));
      return true;
    },

    undo() {
      const d = docOf(get());
      if (!d) return;
      const r = undoHist(d.hist, { w: d.w, h: d.h, layers: d.layers, sel: d.sel, comic: d.comic });
      if (!r) return;
      patchDoc(d.id, { ...r.snap, hist: r.h, dirty: true });
      set({ crop: null, textEdit: null });
    },
    redo() {
      const d = docOf(get());
      if (!d) return;
      const r = redoHist(d.hist, { w: d.w, h: d.h, layers: d.layers, sel: d.sel, comic: d.comic });
      if (!r) return;
      patchDoc(d.id, { ...r.snap, hist: r.h, dirty: true });
      set({ crop: null, textEdit: null });
    },
    setCanvasSize(w, h, a, fill = "transparent") {
      commit((d) => {
        const { dx, dy } = canvasShift(d, { w, h }, a);
        const moved = moveComic(d, d.layers.map((l) => (l.bubble ? l : { ...l, x: l.x + dx, y: l.y + dy })), dx, dy, 1);
        const layers = moved.layers;
        // ★「빈 자리」— 넓어진 자리**만** 색으로 채운 레이어를 맨 아래에 깐다 (지금 캔버스 자리는 비워 두므로 투명 그림의 안쪽은 안 덮는다)
        //   ★만화 캔버스는 페이지마다 한 장씩 (페이지가 모두 캔버스 크기다)
        if (fill !== "transparent" && growsBeyond(d, { w, h }, a)) {
          for (const pid of d.comic?.pages ?? [null]) {
            const cv = fillAround(w, h, FILL_COLOR[fill], { x: dx, y: dy, w: d.w, h: d.h });
            layers.unshift({ ...mkLayer(cv, t("editor.fillLayer"), { x: 0, y: 0, w, h }), ...(pid ? { page: pid } : {}) });
          }
        }
        return { w, h, layers, ...(moved.comic ? { comic: moved.comic } : {}) };
      });
    },
    setImageSize(w, h) {
      commit((d) => {
        const sx = w / d.w;
        const sy = h / d.h;
        // 만화 페이지의 말풍선·여백·간격은 폭의 비(`sx`)로 따라간다
        const moved = moveComic(d, d.layers.map((l) => (l.bubble ? l : { ...l, ...scaleXform(l, sx, sy) })), 0, 0, sx);
        return { w, h, layers: moved.layers, ...(moved.comic ? { comic: moved.comic } : {}) };
      });
    },
    setCrop: (r) => set({ crop: r }),
    applyCrop() {
      const r = get().crop;
      if (!r || r.w < 1 || r.h < 1) return;
      commit((d) => {
        const moved = moveComic(d, d.layers.map((l) => (l.bubble ? l : { ...l, ...cropShift(l, r) })), -r.x, -r.y, 1);
        return { w: r.w, h: r.h, layers: moved.layers, ...(moved.comic ? { comic: moved.comic } : {}) };
      });
      set({ crop: null });
    },
    rotate90() {
      // 컷·말풍선은 돌리지 않는다 (컷은 꼭짓점으로, 말풍선은 꼬리로 모양을 정한다)
      commit((d) => ({ layers: d.layers.map((l) => (d.sel.includes(l.id) && !l.panel && !l.bubble ? { ...l, ...rot90(l) } : l)) }));
    },
    flip(axis) {
      commit((d) => ({ layers: d.layers.map((l) => (d.sel.includes(l.id) && !l.panel && !l.bubble ? { ...l, ...(axis === "h" ? { flipH: !l.flipH } : { flipV: !l.flipV }) } : l)) }));
    },

    setComic(p, live = false) {
      const d = docOf(get());
      if (!d?.comic) return;
      const comic = { ...d.comic, ...p };
      const rebake = p.border !== undefined || p.color !== undefined;
      const next = { comic, ...(rebake ? { layers: d.layers.map((l) => rebakePanel(l, comic)) } : {}) };
      if (live) patchDoc(d.id, { ...next, dirty: true });
      else commit(() => next);
    },
    setPage(pid) {
      const d = docOf(get());
      if (!d?.comic || !d.comic.pages.includes(pid) || d.page === pid) return;
      patchDoc(d.id, { page: pid });
    },
    revealPage(pid) {
      const d = docOf(get());
      if (!d?.comic || !d.comic.pages.includes(pid)) return;
      if (d.page !== pid) patchDoc(d.id, { page: pid });
      set((st) => ({ reveal: { doc: d.id, page: pid, n: (st.reveal?.n ?? 0) + 1 } }));
    },
    setCut(id) {
      const d = docOf(get());
      if (!d?.comic) return;
      const p = id ? d.layers.find((l) => l.id === id && l.panel) : null;
      patchDoc(d.id, { cut: p ? p.id : null, ...(p ? { page: pageOfLayer(p, d.comic.pages) } : {}) });
      if (p) set({ comicView: "cut" });
    },
    addPage(after, layout = "blank") {
      const d = docOf(get());
      if (!d?.comic) return null;
      const pid = newId("pg");
      commit((dd) => {
        const c = dd.comic!;
        const i = after ? c.pages.indexOf(after) : -1;
        const pages = [...c.pages];
        pages.splice(i < 0 ? pages.length : i + 1, 0, pid);
        const comic = { ...c, pages };
        const layers: Layer[] = [...dd.layers, mkPaper(dd.w, dd.h, pid)];
        for (const poly of templatePanels(comic, layout)) layers.push(mkPanel({ layers }, poly, comic, pid));
        return { comic, layers, sel: [] };
      });
      patchDoc(d.id, { page: pid, cut: null });
      return pid;
    },
    async removePage(pid) {
      const d = docOf(get());
      if (!d?.comic || d.comic.pages.length <= 1 || !d.comic.pages.includes(pid)) return;
      const mine = pageLayers(d.layers, d.comic.pages, pid);
      // ★생성물이 화면에서 사라지는 삭제는 묻는다 (데스크 지침 「확인 창」) — 컷에 든 그림이 있을 때만
      const kids = mine.filter((l) => l.clip && !l.draw && mine.some((p) => p.id === l.clip && p.panel)).length;
      const n = d.comic.pages.indexOf(pid);
      if (kids && !(await ask({ title: t("editor.pageDelTitle", { p: pageLabelOf(n) }), body: t("editor.pageDelBody", { n: kids }), ok: t("editor.delete"), cancel: t("common.cancel"), danger: true })))
        return;
      const te = get().textEdit;
      if (te && mine.some((l) => l.id === te.id)) set({ textEdit: null });
      commit((dd) => {
        const ids = new Set(pageLayers(dd.layers, dd.comic!.pages, pid).map((l) => l.id));
        return { comic: { ...dd.comic!, pages: dd.comic!.pages.filter((x) => x !== pid) }, layers: dd.layers.filter((l) => !ids.has(l.id)), sel: dd.sel.filter((id) => !ids.has(id)) };
      });
    },
    patchCommon(fn) {
      commit((d) => (d.comic ? { comic: { ...d.comic, common: fn(d.comic.common) } } : null));
    },
    setComicGen(docId, k, v) {
      const d = get().docs.find((x) => x.id === docId);
      if (!d?.comic || !(COMIC_GEN_KEYS as readonly string[]).includes(k)) return;
      patchDoc(docId, { gen: { ...comicGenOf(d.gen, useGen.getState().params), [k]: v } });
    },
    async removeComicChar(id) {
      const d = docOf(get());
      const ch = d?.comic?.common.chars.find((c) => c.id === id);
      if (!d?.comic || !ch) return;
      const used = d.layers.filter((l) => l.panel && genOf(l.panel).cast.some((c) => c.who === id)).length;
      if (used && !(await ask({ title: t("editor.charDelTitle", { name: ch.name || "?" }), body: t("editor.charDelBody", { n: used }), ok: t("editor.delete"), cancel: t("common.cancel") })))
        return;
      commit((dd) => ({
        comic: { ...dd.comic!, common: { ...dd.comic!.common, chars: dd.comic!.common.chars.filter((c) => c.id !== id) } },
        layers: dd.layers.map((l) => {
          if (!l.panel) return l;
          const g = genOf(l.panel);
          return g.cast.some((c) => c.who === id) ? { ...l, panel: { ...l.panel, gen: { ...g, cast: g.cast.filter((c) => c.who !== id) } } } : l;
        }),
      }));
    },
    appendConti(docId, spec) {
      const d = get().docs.find((x) => x.id === docId);
      if (!d?.comic) return null;
      const c0 = d.comic;
      const last = c0.pages[c0.pages.length - 1];
      // ★마지막 페이지가 비어 있으면 거기에 깐다 (설계 10-2) — 용지 한 장과 내용 없는 컷뿐인 페이지
      const mine = pageLayers(d.layers, c0.pages, last);
      const blankCut = (l: Layer) => { const g = genOf(l.panel); return !g.summary && !g.blocks.length && !g.cast.length && !g.bg && !g.takes.length; };
      const reused = mine.every((l, i) => (l.panel ? blankCut(l) && !mine.some((k) => k.clip === l.id) : i === 0 && !l.bubble && !l.sfx && !l.text && !l.clip));
      const pid = reused ? last : newId("pg");
      const ui = useUi.getState().editorBubble;
      const scale = d.w / 1654;
      commitDoc(d, (dd) => {
        const c = dd.comic!;
        const comic: ComicMeta = {
          ...c,
          pages: reused ? c.pages : [...c.pages, pid],
          common: spec.bgs.length ? { ...c.common, bgs: [...c.common.bgs, ...spec.bgs] } : c.common,
        };
        let layers: Layer[] = reused ? dd.layers.filter((l) => !(l.panel && pageOfLayer(l, c.pages) === pid)) : [...dd.layers, mkPaper(dd.w, dd.h, pid)];
        const made: Layer[] = [];
        for (const cut of spec.cuts) {
          const p = mkPanel({ layers }, framePanel(comic, cut.box), comic, pid, { ...cut.gen, takes: [] });
          layers = [...layers, p];
          made.push(p);
        }
        // 말풍선 — 편집기 담당일 때만 온다. 자리는 그 컷 상자 안 비율, 크기는 A4 보통 폭을 기준으로 캔버스 폭에 맞춘다
        for (const b of spec.bubbles) {
          const p = made[b.cut];
          if (!p?.panel || !b.text.trim()) continue;
          const box = bboxOf(panelPts(p, p.panel.pts));
          const at = { x: box.x + b.x * box.w, y: box.y + b.y * box.h };
          const base: BubbleMeta = {
            kind: b.kind, value: b.text, font: ui.font, size: Math.max(8, ui.size * scale), color: ui.color, bold: ui.bold, align: "center",
            vertical: ui.vertical, fit: "text", pad: ui.pad * scale, lineGap: ui.lineGap, stroke: Math.max(0.5, ui.stroke * scale), line: ui.line, fill: ui.fill,
            body: { x: at.x, y: at.y, w: 0, h: 0 }, tails: [],
          };
          const fitted = fitBubble(base);
          const body = { ...fitted.body, x: at.x - fitted.body.w / 2, y: at.y - fitted.body.h / 2 };
          const tails: Tail[] = hasTails(b.kind) && b.tail
            ? [{ x: box.x + b.tail.x * box.w, y: box.y + b.tail.y * box.h, w: Math.max(8, base.size * 0.55), bend: 0 }]
            : [];
          const l0 = { ...mkLayer(makeCanvas(1, 1), textLayerName(b.text, t("editor.bubbleN", { n: 1 })), { x: 0, y: 0, w: 1, h: 1 }), page: pid };
          layers = [...layers, withBubble(l0, { ...fitted, body, tails })];
        }
        return { comic, layers, sel: [] };
      });
      patchDoc(d.id, { page: pid, cut: null });
      return { page: pid, index: (get().docs.find((x) => x.id === docId)?.comic?.pages ?? []).indexOf(pid), reused };
    },
    async applyLayout(key) {
      const d = docOf(get());
      const pid = d ? curPage(d) : null;
      if (!d?.comic || !pid) return;
      const mine = pageLayers(d.layers, d.comic.pages, pid);
      const panels = mine.filter((l) => l.panel);
      const kids = mine.filter((l) => l.clip && panels.some((p) => p.id === l.clip));
      if (kids.length && !(await ask({ title: t("editor.layoutAskTitle"), body: t("editor.layoutAskBody", { n: kids.length }), ok: t("editor.apply"), cancel: t("common.cancel") })))
        return;
      commit((dd) => {
        const comic = dd.comic!;
        const gone = new Set(panels.map((p) => p.id));
        // 지금 페이지의 있던 컷만 거두고 그 안의 그림은 컷 밖으로 (지우지 않는다)
        const layers: Layer[] = dd.layers.filter((l) => !gone.has(l.id)).map((l) => (l.clip && gone.has(l.clip) ? { ...l, clip: undefined } : l));
        for (const poly of templatePanels(comic, key)) layers.push(mkPanel({ layers }, poly, comic, pid));
        return { layers, sel: [] };
      });
    },
    addPanel(poly) {
      commit((d) => {
        const pid = curPage(d);
        if (!d.comic || !pid) return null;
        // ★새 컷은 지금 컷의 배경과 인물을 이어받는다 (설계 8-1) — 같은 페이지의 컷일 때만
        const from = curCut(d);
        const l = mkPanel(d, poly, d.comic, pid, from && pageOfLayer(from, d.comic.pages) === pid ? inherit(from) : undefined);
        return { layers: [...d.layers, l], sel: [l.id] };
      });
    },
    splitPanels(ids, a, b) {
      let done = false;
      commit((d) => {
        if (!d.comic) return null;
        const comic = d.comic;
        let layers = d.layers;
        for (const id of ids) {
          const p = layers.find((l) => l.id === id);
          if (!p?.panel) continue;
          const halves = splitPoly(panelPts(p, p.panel.pts), a, b, gapFor(a, b, comic.gapX, comic.gapY));
          if (!halves) continue;
          done = true;
          // ★한쪽은 원래 컷 id 를 이어받는다 — 그 컷에 든 그림이 그대로 남는다. 다른 쪽은 새 컷 (배경과 인물을 이어받는다)
          const [one, two] = halves;
          const { box, pts } = toPanel(one);
          const kept = rebakePanel({ ...p, ...box, panel: { ...p.panel, pts } }, comic);
          const made = mkPanel({ layers }, two, comic, pageOfLayer(p, comic.pages), inherit(p));
          layers = layers.flatMap((l) => (l.id === id ? [kept, made] : [l]));
        }
        return done ? { layers, sel: [] } : null;
      });
      return done;
    },
    setPanelPoly(id, poly, live = false) {
      const d = docOf(get());
      const p = d?.layers.find((l) => l.id === id);
      if (!d?.comic || !p?.panel) return;
      const { box, pts } = toPanel(poly);
      const next = rebakePanel({ ...p, ...box, panel: { ...p.panel, pts } }, d.comic);
      const layers = d.layers.map((l) => (l.id === id ? next : l));
      if (live) patchDoc(d.id, { layers, dirty: true });
      else commit(() => ({ layers }));
    },
    setPanelBorder(id, noBorder) {
      commit((d) => ({
        layers: d.layers.map((l) => (l.id === id && l.panel && d.comic ? rebakePanel({ ...l, panel: { ...l.panel, noBorder } }, d.comic) : l)),
      }));
    },
    setClip(id, panel) {
      commit((d) => {
        const l = d.layers.find((x) => x.id === id);
        if (!l || l.panel || l.bubble) return null;
        if (!panel) return { layers: d.layers.map((x) => (x.id === id ? { ...x, clip: undefined } : x)) };
        const p = d.layers.find((x) => x.id === panel && x.panel);
        if (!p?.panel) return null;
        // 컷을 가득 채우게 (가운데 맞춤) — 원본 비율은 지킨다
        const at = coverRect(bboxOf(panelPts(p, p.panel.pts)), { w: l.w, h: l.h });
        return { layers: d.layers.map((x) => (x.id === id ? { ...x, ...at, clip: panel } : x)) };
      });
    },
    setPanelGen(id, p, live = false) {
      const d = get().docs.find((x) => x.layers.some((l) => l.id === id && l.panel));
      if (!d) return;
      const layers = d.layers.map((l) =>
        l.id === id && l.panel ? { ...l, panel: { ...l.panel, gen: { ...genOf(l.panel), ...p } } } : l,
      );
      if (live) patchDoc(d.id, { layers, dirty: true });
      else commitDoc(d, () => ({ layers }));
    },
    placeTake(docId, panelId, take, cv, name) {
      const d = get().docs.find((x) => x.id === docId);
      const p = d?.layers.find((l) => l.id === panelId && l.panel);
      if (!d || !p?.panel) return;
      commitDoc(d, (dd) => {
        const at = coverRect(bboxOf(panelPts(p, p.panel!.pts)), { w: cv.width, h: cv.height });
        const old = dd.layers.find((l) => l.clip === panelId && l.take !== undefined);
        const layer: Layer = { ...mkLayer(cv, name, at), ...pageFor(dd, p), clip: panelId, take };
        const g = genOf(p.panel);
        const takes = take && !g.takes.some((x) => x.ws === take.ws && x.file === take.file) ? [...g.takes, take] : g.takes;
        const layers = (old ? dd.layers.map((l) => (l.id === old.id ? { ...layer, id: old.id } : l)) : [...dd.layers, layer]).map((l) =>
          l.id === panelId && l.panel ? { ...l, panel: { ...l.panel, gen: { ...g, takes } } } : l,
        );
        return { layers };
      });
    },
    addBubble(at) {
      const ui = useUi.getState().editorBubble;
      let made: string | null = null;
      commit((d) => {
        const base: BubbleMeta = {
          kind: ui.kind, value: "", font: ui.font, size: ui.size, color: ui.color, bold: ui.bold, align: "center",
          vertical: ui.vertical, fit: "text", pad: ui.pad, lineGap: ui.lineGap, stroke: ui.stroke, line: ui.line, fill: ui.fill,
          body: { x: at.x, y: at.y, w: 0, h: 0 }, tails: [],
        };
        const fitted = fitBubble(base);
        const body = { ...fitted.body, x: at.x - fitted.body.w / 2, y: at.y - fitted.body.h / 2 };
        const tails = hasTails(ui.kind) ? [defaultTail(body, d.comic?.dir ?? "rtl", ui.size)] : [];
        const l0 = { ...mkLayer(makeCanvas(1, 1), nextName(d.layers.map((x) => x.name), (n) => t("editor.bubbleN", { n })), { x: 0, y: 0, w: 1, h: 1 }), ...pageFor(d) };
        const l = withBubble(l0, { ...fitted, body, tails }, true);
        made = l.id;
        return { layers: [...d.layers, l], sel: [l.id] };
      });
      if (made) set({ textEdit: { id: made, fresh: true, value: "" } });
    },
    patchBubble(id, p, live = false) {
      const d = get().docs.find((x) => x.layers.some((l) => l.id === id));
      const l = d?.layers.find((x) => x.id === id);
      if (!d || !l?.bubble) return;
      const hide = get().textEdit?.id === id;
      const next = withBubble(l, { ...l.bubble, ...p }, hide);
      // 이름은 글의 첫 줄 (글자 레이어와 같은 규칙)
      const named = "value" in p ? { ...next, name: textLayerName(next.bubble!.value, l.name) } : next;
      const layers = d.layers.map((x) => (x.id === id ? named : x));
      if (live) patchDoc(d.id, { layers, dirty: true });
      else commitDoc(d, () => ({ layers }));
    },
    addSfx(at) {
      const ui = useUi.getState().editorSfx;
      commit((d) => {
        // 크기는 A4 보통(폭 1654)에서의 값을 캔버스 폭에 맞춘다
        const size = Math.max(8, Math.round(ui.size * (d.w / 1654)));
        const m = newSfx(ui.text || "쾅", size, ui.style, Math.floor(Math.random() * 1e9) + 1);
        const { cv } = bakeSfx(m);
        const l: Layer = {
          ...mkLayer(cv, nextName(d.layers.map((x) => x.name), (n) => t("editor.sfxN", { n })), { x: at.x - cv.width / 2, y: at.y - cv.height / 2, w: cv.width, h: cv.height }),
          name: textLayerName(m.value, t("editor.sfxN", { n: 1 })),
          ...pageFor(d),
          sfx: m,
        };
        return { layers: [...d.layers, l], sel: [l.id] };
      });
    },
    patchSfx(id, p, live = false) {
      const d = get().docs.find((x) => x.layers.some((l) => l.id === id));
      const l = d?.layers.find((x) => x.id === id);
      if (!d || !l?.sfx) return;
      const next = withSfx(l, { ...l.sfx, ...p, ...(p.style === undefined && Object.keys(p).some((k) => k !== "value" && k !== "seed" && k !== "size") ? { style: "custom" as const } : {}) });
      const named = "value" in p ? { ...next, name: textLayerName(next.sfx!.value, l.name) } : next;
      const layers = d.layers.map((x) => (x.id === id ? named : x));
      if (live) patchDoc(d.id, { layers, dirty: true });
      else commitDoc(d, () => ({ layers }));
    },
    styleSfx(id, style) {
      const l = get().docs.flatMap((d) => d.layers).find((x) => x.id === id);
      if (!l?.sfx) return;
      get().patchSfx(id, withStyle(l.sfx, style));
    },
    settleSfx(id) {
      const d = get().docs.find((x) => x.layers.some((l) => l.id === id));
      const l = d?.layers.find((x) => x.id === id);
      if (!d || !l?.sfx || (l.w === l.sw && l.h === l.sh)) return;
      const k = (l.w / l.sw + l.h / l.sh) / 2;
      const next = withSfx(l, { ...l.sfx, size: Math.max(4, l.sfx.size * k) });
      patchDoc(d.id, { layers: d.layers.map((x) => (x.id === id ? next : x)), dirty: true });
    },
    refreshGlyphs() {
      const te = get().textEdit;
      set((s) => ({
        docs: s.docs.map((d) =>
          d.layers.some((l) => l.bubble || l.sfx)
            ? { ...d, layers: d.layers.map((l) => (l.bubble ? withBubble(l, l.bubble, te?.id === l.id) : l.sfx ? withSfx(l, l.sfx) : l)) }
            : d,
        ),
        rev: s.rev + 1,
      }));
    },
    dragLayers(start, dx, dy) {
      const d = docOf(get());
      if (!d) return;
      const by = new Map(start.map((l) => [l.id, l]));
      const layers = d.layers.map((l) => {
        const s0 = by.get(l.id);
        if (!s0) return l;
        // ★말풍선은 몸통만 옮긴다 — 꼬리 끝은 말하는 사람을 계속 가리키게 제자리 (설계 9-1)
        if (s0.bubble) return withBubble(l, shiftBubble(s0.bubble, dx, dy, 1, s0.bubble.tails));
        return { ...l, x: s0.x + dx, y: s0.y + dy };
      });
      patchDoc(d.id, { layers, dirty: true });
    },

    async save() {
      const d = docOf(get());
      if (!d || get().busy) return null;
      const editLast = useUi.getState().editLast;
      const where = whereOf(d, editLast);
      if (where.mode !== "overwrite" && !where.dest) {
        toast(t("editor.needDest"), "warn");
        return null;
      }
      set({ busy: true });
      try {
        // ★만화 캔버스는 페이지마다 한 장씩 — `<캔버스>_p01.png` … (목업 v2 의 저장 칸). 이름이 겹치면 서버가 번호를 붙인다 (덮지 않는다)
        const shots = d.comic
          ? d.comic.pages.map((pid, i) => ({ image: exportDataUrl(pageView(d, pid)), name: `${d.name}_${pageLabelOf(i).replace(".", "")}.png` }))
          : [{ image: get().dataUrl(), name: d.src?.name ?? `${d.name}.png` }];
        let first: { file: string; name: string } | null = null;
        for (const x of shots) {
          const r = await saveImage({
            image: x.image,
            name: x.name,
            fmt: editLast.fmt,
            mode: where.mode,
            dest: "dest" in where ? where.dest : undefined,
            rel: d.src?.rel,
            path: d.src?.path,
            ...(d.comic ? { suffix: "" } : {}),
          });
          first ??= r;
        }
        patchDoc(d.id, { dirty: false });
        toast(shots.length > 1 ? t("editor.savedPages", { n: shots.length, name: first!.name }) : t("editor.saved", { name: first!.name }));
        return first;
      } catch (e) {
        toast(t("editor.saveFail", { e: String(e) }), "warn");
        return null;
      } finally {
        set({ busy: false });
      }
    },
    dataUrl() {
      const d = docOf(get());
      if (!d) return "";
      const pid = curPage(d);
      return exportDataUrl(pid ? pageView(d, pid) : d);
    },
  };
});

// ★만화 글꼴을 다 실으면 말풍선·효과음을 다시 굽는다 — 그동안은 앱 글꼴로 그려져 있었다 (설계 9-3)
whenFontsLoad(() => useEditor.getState().refreshGlyphs());

// ★캔버스가 바뀌면 남긴다 — 다 읽은 뒤부터 (`persist.ts` 머리)
useEditor.subscribe((s, prev) => {
  if (!s.hydrated) return;
  if (s.docs !== prev.docs || s.cur !== prev.cur || !prev.hydrated) scheduleFlush(() => ({ docs: useEditor.getState().docs, cur: useEditor.getState().cur }));
});

/** 저장 파일 이름 미리보기 (오른쪽 기둥) — 만화 캔버스는 첫 페이지와 끝 페이지 (`1화_p01.png ~ p02.png`) */
export const saveName = (d: Doc | null, fmt: "png" | "webp") => {
  if (d?.comic) {
    const n = d.comic.pages.length;
    const first = `${d.name}_${pageLabelOf(0).replace(".", "")}.${fmt}`;
    return n > 1 ? `${first} ~ ${pageLabelOf(n - 1).replace(".", "")}.${fmt}` : first;
  }
  return saveNameOf(d?.src?.name ?? (d ? `${d.name}.png` : null), fmt);
};

/** 저장 자리 — **화면(오른쪽 기둥·머리 줄)과 저장이 같은 셈**을 쓴다. 원본 자리가 없는 캔버스(새 캔버스·떨군 바이트)는
 *  덮어쓰기·하위 output 이 성립하지 않아 설정이 무엇이든 「저장 폴더 지정」이다 */
export const whereOf = (d: Doc, e: { mode: "overwrite" | "sub" | "folder"; dest: string }) =>
  destOf(d.src ? e.mode : "folder", e.dest, dirOf(d.src?.rel ?? d.src?.path));
