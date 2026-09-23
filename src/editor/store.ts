/** 이미지 편집 — **상태** (캔버스·레이어·도구·이력). 계산은 `model.ts`, 픽셀은 `pixels.ts`, 남기는 것은 `persist.ts`.
 *
 *  ★★열어 둔 캔버스는 **재실행 뒤에도 남는다** (사용자 지시 2026-09-22): 레이어 픽셀은 `data/editor/<캔버스>/<키>.png`,
 *    나머지는 `state.json`. 바뀔 때마다 1초 뒤 `persist.ts` 가 적고, 처음 쓸 때 `loadDocs` 로 되살린다. 이력은 안 남긴다.
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
  FILL_COLOR, NO_ADJUST, canvasShift, cropShift, destOf, dirOf, docToLayer, emptyHist, growsBeyond, hasAdjust, keepAnchor, nextName, placeNew, pushHist,
  redoHist, rotate90 as rot90, saveNameOf, scaleXform, textLayerName, undoHist,
  type Adjust, type Anchor, type Fill, type Hist, type Rect, type TextMeta,
} from "./model";
import { bakeBubble, bakePanel, bakeStroke, bucketFill, clipOf, cloneCanvas, exportDataUrl, fillAround, fitBubble, makeCanvas, mergeInto, rebakeText, renderText, type Layer, type Stroke } from "./pixels";
import {
  bboxOf, comicStack, coverRect, defaultTail, gapFor, hasTails, newPage, panelPts, splitPoly, templatePanels, toPanel,
  type BubbleMeta, type ComicPage, type CutTake, type Dir, type PanelGen, type Pt, type Tail,
} from "./comic";
import { loadItem, saveImage } from "./io";
import { loadDocs, scheduleFlush } from "./persist";

export type Tool = "select" | "brush" | "eraser" | "bucket" | "text" | "crop" | "pan" | "panel" | "bubble";

type Snap = { w: number; h: number; layers: Layer[]; sel: string[]; comic?: ComicPage };

/** 새 캔버스 — 만화 페이지면 `comic` 에 읽는 방향과 첫 배치 (설계 3번 · 목업 ②) */
export type NewDocOpts = { w: number; h: number; comic?: { dir: Dir; layout: string } };

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
  /** 만화 페이지 캔버스면 그 속성 (없으면 보통 이미지 캔버스) — 설계 2번 「새 모드가 아니라 캔버스의 한 종류」 */
  comic?: ComicPage;
};

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
  ready: Promise<void>;
  /** 글자 도구로 고치는 중인 글자 레이어. `fresh` 는 방금 만든 것 — 빈 채로 끝나면 레이어를 거둔다.
   *  ★치는 글(`value`)은 **여기**에 있다 — 글 상자가 사라지는 경로(도구 바꾸기·캔버스 옮기기·개발 모드의 이중 마운트)가
   *    여럿이라, 화면의 정리 효과가 아니라 스토어의 `endTextEdit` 하나가 마무리한다 (사용자 지적 2026-09-22: 눌러도 안 생겼다) */
  textEdit: { id: string; fresh: boolean; value: string } | null;

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

  /* ── 만화 페이지 ── */
  /** 페이지 값(간격·테두리·색·안내선·읽는 방향)을 고친다 — 테두리가 바뀌면 컷을 다시 굽는다 (한 걸음) */
  setComic: (p: Partial<ComicPage>, live?: boolean) => void;
  /** 첫 배치를 다시 편다 — 있던 컷은 거둔다 (그 안의 그림은 컷 밖 레이어로 남는다). 컷에 그림이 있으면 묻는다 */
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
  /** 고른 것들을 함께 옮긴다 (끄는 중, 이력 없이) — 말풍선은 몸통만 옮기고 **꼬리 끝은 제자리**다 (설계 9-1) */
  dragLayers: (start: Layer[], dx: number, dy: number) => void;

  /** 합성해 저장한다. 성공하면 저장된 자리 */
  save: () => Promise<{ file: string; name: string } | null>;
  /** 문서 크기 그대로의 PNG data URL (i2i·인페인트·보내기가 받는다) */
  dataUrl: () => string;
};

let seq = 1;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const DEFAULT_W = 1216;
const DEFAULT_H = 832;

const docOf = (s: S) => s.docs.find((d) => d.id === s.cur) ?? null;
/** 고른 것 가운데 으뜸 — 마지막에 고른 것 */
export const primaryOf = (d: { sel: string[] }): string | null => d.sel[d.sel.length - 1] ?? null;

export const useEditor = create<S>((set, get) => {
  /** 한 걸음 — 직전 상태를 적고 바꾼다 (그 문서에) */
  const commitDoc = (d: Doc, fn: (d: Doc) => Partial<Doc> | null) => {
    const next = fn(d);
    if (!next) return;
    const snap: Snap = { w: d.w, h: d.h, layers: d.layers, sel: d.sel, comic: d.comic };
    // ★만화 페이지는 레이어 차례를 묶음(그 밖 → 컷마다 [그림, 테두리] → 말풍선)으로 맞춘다 (`comicStack`)
    if (d.comic && next.layers) next.layers = comicStack(next.layers);
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
  /** 컷 레이어 — 테두리만 구운 캔버스. 이름은 「컷」 + 만든 차례 (화면의 번호는 읽는 차례로 따로 센다) */
  const mkPanel = (d: { layers: Layer[] }, poly: Pt[], page: ComicPage): Layer => {
    const { box, pts } = toPanel(poly);
    const panel = { pts, noBorder: false };
    return {
      ...mkLayer(bakePanel(panel, box.w, box.h, page), nextName(d.layers.map((l) => l.name), (n) => t("editor.panelN", { n })), box),
      panel,
    };
  };
  /** 컷을 지금 상자 크기로 다시 굽는다 (옮기거나 늘렸거나 페이지 테두리가 바뀌었을 때) */
  const rebakePanel = (l: Layer, page: ComicPage): Layer =>
    l.panel ? { ...l, cv: bakePanel(l.panel, l.w, l.h, page), sw: Math.max(1, Math.round(l.w)), sh: Math.max(1, Math.round(l.h)) } : l;
  /** 말풍선 원문 → 레이어 (몸통을 글에 맞추고 상자·픽셀을 새로) */
  const withBubble = (l: Layer, b: BubbleMeta, hideText = false): Layer => {
    const fb = fitBubble(b);
    const { box, cv } = bakeBubble(fb, hideText);
    return { ...l, bubble: fb, cv, sw: cv.width, sh: cv.height, x: box.x, y: box.y, w: box.w, h: box.h };
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
  const moveComic = (d: Doc, layers: Layer[], dx: number, dy: number, k: number): { layers: Layer[]; comic?: ComicPage } => {
    if (!d.comic) return { layers };
    const c = d.comic;
    const comic: ComicPage = {
      ...c,
      frame: { x: c.frame.x * k + dx, y: c.frame.y * k + dy, w: c.frame.w * k, h: c.frame.h * k },
      gapX: c.gapX * k, gapY: c.gapY * k, border: Math.max(1, c.border * k),
    };
    return {
      comic,
      layers: layers.map((l) => (l.panel ? rebakePanel(l, comic) : l.bubble ? withBubble(l, shiftBubble(l.bubble, dx, dy, k)) : l)),
    };
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

  // ★처음 쓸 때 남겨 둔 캔버스를 되살린다. 그 전에 연 것(빠르게 보낸 그림)은 뒤에 붙인다
  const ready = (async () => {
    try {
      const { docs, cur } = await loadDocs();
      set((s) => ({ docs: [...docs, ...s.docs], cur: s.cur ?? (docs.some((d) => d.id === cur) ? cur : (docs[0]?.id ?? null)), hydrated: true }));
    } catch (e) {
      console.warn("[editor] 남겨 둔 캔버스를 못 읽었다", e);
      set({ hydrated: true });
    }
  })();

  return {
    docs: [],
    cur: null,
    tool: "brush",
    ratioLock: true,
    crop: null,
    rev: 0,
    busy: false,
    hydrated: false,
    ready,
    textEdit: null,

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
              const l: Layer = { ...mkLayer(x.cv, x.name.replace(/\.[^.]+$/, ""), at), ...(into ? { clip: into.id } : {}) };
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
      // ★만화 페이지 — 흰 용지 한 장 + 첫 배치의 컷들 (설계 3번 · 5번). 안내선은 화면에만 있다
      const comic = newPage({ w, h }, o.comic.dir);
      const paperCv = makeCanvas(w, h);
      const g = paperCv.getContext("2d")!;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      const layers: Layer[] = [mkLayer(paperCv, t("editor.paper"), { x: 0, y: 0, w, h })];
      for (const poly of templatePanels(comic, o.comic.layout)) layers.push(mkPanel({ layers }, poly, comic));
      const name = nextName(names, (n) => t("editor.pageN", { n }));
      const doc: Doc = {
        id: newId("d"), name, w, h, layers, sel: [], src: null, hist: emptyHist(), dirty: false,
        view: { fit: true, zoom: 1 }, comic,
      };
      // 컷이 있으면 말풍선 도구, 빈 페이지면 컷 도구로 시작한다
      set((s) => ({ docs: [...s.docs, doc], cur: doc.id, crop: null, textEdit: null, tool: layers.length > 1 ? "select" : "panel" }));
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
      set({ cur: id, crop: null });
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
    setRatioLock: (v) => set({ ratioLock: v }),
    setView(v) {
      const d = docOf(get());
      if (d) patchDoc(d.id, { view: { ...d.view, ...v } });
    },

    selectLayer(id) {
      const d = docOf(get());
      if (!d) return;
      const next = id ? [id] : [];
      if (d.sel.length !== next.length || d.sel[0] !== next[0]) patchDoc(d.id, { sel: next });
    },
    toggleSelect(id) {
      const d = docOf(get());
      if (!d) return;
      patchDoc(d.id, { sel: d.sel.includes(id) ? d.sel.filter((x) => x !== id) : [...d.sel, id] });
    },
    selectMany(ids) {
      const d = docOf(get());
      if (!d) return;
      if (ids.length !== d.sel.length || ids.some((id, i) => d.sel[i] !== id)) patchDoc(d.id, { sel: ids });
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
        const l = mkLayer(makeCanvas(d.w, d.h), layerName(d), { x: 0, y: 0, w: d.w, h: d.h });
        const i = d.layers.findIndex((x) => x.id === primaryOf(d));
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
        if (i <= 0) return null;
        const top = d.layers[i];
        const below = d.layers[i - 1];
        // ★컷·말풍선은 원문에서 굽는 레이어라 합치지 않는다 (합치면 원문을 잃는다)
        if (top.panel || top.bubble || below.panel || below.bubble) return null;
        // ★합친 결과는 보통 레이어다 — 아래가 글자 레이어였어도 원문을 떼어 낸다 (남기면 다음 고치기가 합친 것을 지운다).
        //   위가 컷에 든 그림이면 그 컷 모양으로 잘라 넣는다
        const merged: Layer = { ...below, text: undefined, cv: mergeInto(below, top, top.clip !== below.clip ? clipOf(d.layers, top) : null) };
        const layers = d.layers.filter((_, k) => k !== i).map((x) => (x.id === below.id ? merged : x));
        return { layers, sel: [below.id] };
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
        if (fill !== "transparent" && growsBeyond(d, { w, h }, a)) {
          const cv = fillAround(w, h, FILL_COLOR[fill], { x: dx, y: dy, w: d.w, h: d.h });
          layers.unshift(mkLayer(cv, t("editor.fillLayer"), { x: 0, y: 0, w, h }));
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
    async applyLayout(key) {
      const d = docOf(get());
      if (!d?.comic) return;
      const panels = d.layers.filter((l) => l.panel);
      const kids = d.layers.filter((l) => l.clip && panels.some((p) => p.id === l.clip));
      if (kids.length && !(await ask({ title: t("editor.layoutAskTitle"), body: t("editor.layoutAskBody", { n: kids.length }), ok: t("editor.apply"), cancel: t("common.cancel") })))
        return;
      commit((dd) => {
        const page = dd.comic!;
        // 있던 컷은 거두고 그 안의 그림은 컷 밖으로 (지우지 않는다)
        const layers: Layer[] = dd.layers.filter((l) => !l.panel).map((l) => (l.clip ? { ...l, clip: undefined } : l));
        for (const poly of templatePanels(page, key)) layers.push(mkPanel({ layers }, poly, page));
        return { layers, sel: [] };
      });
    },
    addPanel(poly) {
      commit((d) => {
        if (!d.comic) return null;
        const l = mkPanel(d, poly, d.comic);
        return { layers: [...d.layers, l], sel: [l.id] };
      });
    },
    splitPanels(ids, a, b) {
      let done = false;
      commit((d) => {
        if (!d.comic) return null;
        const page = d.comic;
        let layers = d.layers;
        for (const id of ids) {
          const p = layers.find((l) => l.id === id);
          if (!p?.panel) continue;
          const halves = splitPoly(panelPts(p, p.panel.pts), a, b, gapFor(a, b, page.gapX, page.gapY));
          if (!halves) continue;
          done = true;
          // ★한쪽은 원래 컷 id 를 이어받는다 — 그 컷에 든 그림이 그대로 남는다. 다른 쪽은 새 컷
          const [one, two] = halves;
          const { box, pts } = toPanel(one);
          const kept = rebakePanel({ ...p, ...box, panel: { ...p.panel, pts } }, page);
          const made = mkPanel({ layers }, two, page);
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
        l.id === id && l.panel ? { ...l, panel: { ...l.panel, gen: { blocks: [], cast: [], takes: [], ...l.panel.gen, ...p } } } : l,
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
        const layer: Layer = { ...mkLayer(cv, name, at), clip: panelId, take };
        const g = { blocks: [], cast: [], takes: [], ...p.panel!.gen };
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
        const l0 = mkLayer(makeCanvas(1, 1), nextName(d.layers.map((x) => x.name), (n) => t("editor.bubbleN", { n })), { x: 0, y: 0, w: 1, h: 1 });
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
        const r = await saveImage({
          image: get().dataUrl(),
          name: d.src?.name ?? `${d.name}.png`,
          fmt: editLast.fmt,
          mode: where.mode,
          dest: "dest" in where ? where.dest : undefined,
          rel: d.src?.rel,
          path: d.src?.path,
        });
        patchDoc(d.id, { dirty: false });
        toast(t("editor.saved", { name: r.name }));
        return r;
      } catch (e) {
        toast(t("editor.saveFail", { e: String(e) }), "warn");
        return null;
      } finally {
        set({ busy: false });
      }
    },
    dataUrl() {
      const d = docOf(get());
      return d ? exportDataUrl(d) : "";
    },
  };
});

// ★캔버스가 바뀌면 남긴다 — 다 읽은 뒤부터 (`persist.ts` 머리)
useEditor.subscribe((s, prev) => {
  if (!s.hydrated) return;
  if (s.docs !== prev.docs || s.cur !== prev.cur || !prev.hydrated) scheduleFlush(() => ({ docs: useEditor.getState().docs, cur: useEditor.getState().cur }));
});

/** 저장 파일 이름 미리보기 (오른쪽 기둥) */
export const saveName = (d: Doc | null, fmt: "png" | "webp") => saveNameOf(d?.src?.name ?? (d ? `${d.name}.png` : null), fmt);

/** 저장 자리 — **화면(오른쪽 기둥·머리 줄)과 저장이 같은 셈**을 쓴다. 원본 자리가 없는 캔버스(새 캔버스·떨군 바이트)는
 *  덮어쓰기·하위 output 이 성립하지 않아 설정이 무엇이든 「저장 폴더 지정」이다 */
export const whereOf = (d: Doc, e: { mode: "overwrite" | "sub" | "folder"; dest: string }) =>
  destOf(d.src ? e.mode : "folder", e.dest, dirOf(d.src?.rel ?? d.src?.path));
