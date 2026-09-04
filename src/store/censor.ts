import { create } from "zustand";
import { t } from "../i18n";
import { api, backendUrl } from "../lib/backend";
import { CensorRenderer, type CoverSettings, type RenderBox } from "../lib/censorRender.ts";
import { fileMgrImg } from "../lib/imgUrl";
import type { Dropped } from "../lib/dropImages";

/** 검열. **여러 장을 한 번에** 찾고, 고치고, 가린다 (v2 자동검열 이식).
 *
 *  v2 의 구조를 그대로 옮겼다. 세 탭이 곧 작업 순서다:
 *
 *      검열 전   담고 · 찾는다        모델·대상·문턱을 만지며 미리 본다
 *      검열 중   고친다               찾은 박스를 옮기고 늘리고 돌리고 지우고 더 그린다
 *      검열 후   다시 고친다          저장된 결과에 박스를 더해 다시 저장한다
 *
 *  ★찾기와 가리기는 **따로**다. 자동으로 바로 가려 버리면 잘못 찾은 것을 되돌릴 수 없다.
 *  ★★가리는 일은 **화면이** 한다 (`lib/censorRender.ts`). 렌더러는 한 벌뿐이고,
 *    저장도 그 렌더러가 원본 크기로 구운 것을 올린다 (`/api/censor/apply`).
 *    서버가 그리던 때에는 박스를 1px 옮길 때마다 왕복이 걸려 초당 3~4장이 천장이었다.
 *  ★모델은 **앱에 들어 있다**. 받아 오는 절차가 없다 (backend/censor.py 머리 주석).
 */
export type Box = {
  label: string;
  confidence: number;
  box: [number, number, number, number];
  /** 라디안. 코드가 아니라 사람이 손잡이로 돌린다 */
  rotation?: number;
  /** ★박스마다 다른 방식 (백엔드 `apply_boxes` 가 박스별 `method` 를 읽는다) */
  method?: string;
  passes_threshold?: boolean;
  /** 사람이 끈 것. 목록에는 두고 적용에서만 뺀다 */
  off?: boolean;
  /** 사람이 그린 것 */
  manual?: boolean;
  /** ★구름 무늬의 씨앗. **박스마다 한 번 붙이고 안 바꾼다** — 옮겨도 같은 구름이 따라오게
   *  (사용자 결정 2026-08-23). 옛것은 좌표로 씨앗을 만들어 1px 만 밀어도 모양이 통째로 바뀌었다 */
  seed?: number;
};

export type CensorModel = { id: string; file: string; classes: string[]; bytes: number; imgsz: number };

/** 검열할 그림 한 장. 세 갈래로 온다 (백엔드 `CensorSource` 와 같은 계약) */
export type CensorImage = {
  id: string;
  name: string;
  /** 아웃풋 루트 기준 (파일 관리에서 고른 것) */
  rel?: string;
  /** 절대 경로 (Tauri 창에 떨군 것) */
  path?: string;
  /** base64 (브라우저에서 고른 것) */
  data?: string;
  w?: number;
  h?: number;
  /** 목록에 그릴 작은 그림 */
  thumb?: string;
};

export type Tab = "before" | "processing" | "after";
export type Tool = "select" | "add" | "delete";

const KEY = "peropix.censor";

/** 저장하는 것. ★필드를 늘리면 **여기에도 더할 것** (ui.ts `commitLayout` 과 같은 함정) */
type Saved = {
  model: string | null;
  targets: string[];
  labelConf: Record<string, number>;
  conf: number;
  floor: number;
  method: string;
  color: string;
  expand: number;
  feather: number;
  mosaic: number;
  mosaicOpacity: number;
  blur: number;
  steamBright: number;
  steamAlpha: number;
  /** 박스를 끄는 동안 덮개가 옅어지는 정도 — ★모든 방식 공통 (CensorSide 의 ★★주) */
  peek: number;
  dest: string;
  /** 저장 자리 — **일괄변환과 같은 세 갈래** (사용자 지시 2026-09-04).
   *  `overwrite` 원본 자리에 · `sub` 첫 그림 아래 `output/` · `folder` 고른 폴더. */
  destMode: "overwrite" | "sub" | "folder";
};

const DEFAULTS: Saved = {
  model: null,
  targets: [],
  labelConf: {},
  conf: 0.3,
  floor: 0.1,
  // ★기본은 **스팀**이다 (v2 의 기본값). 폐기 결정이 없어 그대로 옮겼다
  method: "steam",
  color: "#000000",
  expand: 0,
  feather: 0,
  mosaic: 12,
  mosaicOpacity: 100,
  blur: 20,
  steamBright: 100,
  steamAlpha: 100,
  peek: 30,
  dest: "",
  // ★기본은 일괄변환과 같은 `sub` — 원본을 건드리지 않는 쪽이 기본이어야 한다
  destMode: "sub",
};

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const got = JSON.parse(raw);
      // ★옛 이름에서 옮겨 온다 — 스팀 전용이던 「들춰보기」가 공통이 되면서 이름이 바뀌었다
      if (got.peek === undefined && typeof got.steamOpacity === "number") got.peek = got.steamOpacity;
      delete got.steamOpacity;
      return { ...DEFAULTS, ...got };
    }
  } catch {}
  return DEFAULTS;
}

/** ★그림 캐시는 **30장까지** (v2 `imgCacheMaxSize`). 떨군 그림은 주소가 없어 서버에서
 *  한 번 받아 와야 하는데, 좌우로 훑을 때마다 다시 받으면 넘기는 리듬이 끊긴다. */
const LRU_MAX = 30;
const srcCache = new Map<string, string>();

function cacheGet(k: string) {
  const v = srcCache.get(k);
  if (v !== undefined) {
    srcCache.delete(k);
    srcCache.set(k, v);
  }
  return v;
}

function cacheSet(k: string, v: string) {
  srcCache.delete(k);
  srcCache.set(k, v);
  while (srcCache.size > LRU_MAX) {
    const oldest = srcCache.keys().next().value!;
    const url = srcCache.get(oldest);
    srcCache.delete(oldest);
    // ★blob 주소는 놓아 주지 않으면 메모리에 계속 남는다
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 그림 하나를 가리키는 세 갈래를 요청 몸통으로 (`CensorSource`) */
const sourceOf = (im: CensorImage) =>
  im.rel ? { rel: im.rel } : im.path ? { path: im.path } : { data: im.data };

/** 그림이 든 폴더 (아웃풋 루트 기준 상대 경로거나 절대 경로). 자리를 모르면 빈 문자열 */
const dirOf = (im: CensorImage) => {
  const p = im.rel ?? im.path ?? "";
  const cut = p.replace(/[\\/][^\\/]*$/, "");
  return cut === p ? "" : cut;
};

/** 저장 창구에 실어 보낼 자리. ★**첫 그림 아래 `output/`** 은 여기서 정한다 —
 *  한 장씩 오는 서버 창구는 어느 것이 첫 장인지 모른다 (일괄변환은 목록을 통째로 받는다). */
function destOf(s: { destMode: string; dest: string }, list: CensorImage[]) {
  if (s.destMode === "overwrite") return { mode: "overwrite" };
  if (s.destMode === "folder") return { dest: s.dest || undefined };
  const home = list.map(dirOf).find((d) => d !== "");
  return { dest: home === undefined ? undefined : `${home}/output`.replace(/^\//, "") };
}

let seq = 1;

type S = Saved & {
  models: CensorModel[];
  tab: Tab;
  /** 검열 전·중 탭이 다루는 목록 */
  images: CensorImage[];
  /** 검열 후 탭이 다루는 목록 (이번에 저장한 것) */
  after: CensorImage[];
  idx: number;
  afterIdx: number;
  /** 그림별 박스. 검열 전에서는 탐지 결과, 검열 중·후에서는 편집 대상 */
  boxes: Record<string, Box[]>;
  sizes: Record<string, { w: number; h: number }>;
  /** 지금 무대에 그릴 원본 주소 (떨군 그림은 서버에서 받아 온 data URL) */
  src: string | null;
  /** 지금 그림의 렌더러. ★무대가 이것으로 **직접 그린다** — 서버를 안 부른다 */
  renderer: CensorRenderer | null;
  /** 그릴 것이 바뀌었다는 표시. 무대가 이 숫자를 보고 다시 그린다 */
  rev: number;
  tool: Tool;
  sel: number;
  /** 손잡이를 잡고 있는 동안. 가린 모습을 옅게 해 아래를 보여 준다 */
  editing: boolean;
  scanning: boolean;
  busy: boolean;
  /** 여러 장을 도는 동안의 진행 (전체 검열 · 일괄 저장) */
  progress: { done: number; total: number; what: "scan" | "save" } | null;
  /** ★「전체 검열」을 한 번 돌렸나. 안 돌린 채로 검열 중 탭에 들어가면 문턱 미달·꺼 둔 박스가
   *  그대로 편집 대상이 되어 무엇을 가리는지 알 수 없다 (v2 도 그때까지 탭을 숨겼다) */
  staged: boolean;
  error: string | null;

  loadModels: () => Promise<void>;
  setModel: (file: string) => void;
  setTab: (t: Tab) => void;
  set: (patch: Partial<S>) => void;
  /** 설정 하나를 바꾼다. 저장하고, 필요하면 다시 찾거나 다시 그린다 */
  tune: (patch: Partial<Saved>, redo?: "scan" | "draw") => void;
  toggleTarget: (label: string) => void;
  setLabelConf: (label: string, v: number) => void;

  addImages: (items: Dropped[]) => Promise<void>;
  toggleRel: (rel: string, name: string) => void;
  removeImage: (i: number) => void;
  clearImages: () => void;
  select: (i: number) => void;
  step: (d: number) => void;

  scan: () => Promise<void>;
  scanAll: () => Promise<void>;
  saveAll: () => Promise<void>;
  saveOne: () => Promise<void>;
  cancelProcessing: () => void;

  cur: () => CensorImage | undefined;
  curBoxes: () => Box[];
  putBoxes: (b: Box[]) => void;
  addBox: (b: [number, number, number, number]) => void;
  removeBox: (i: number) => void;
  toggleBox: (i: number) => void;
  setBoxMethod: (i: number, m: string) => void;
  /** 검열 방식을 바꾼다 — ★**검열 중·후에는 지금 그림의 박스 전부**에 건다 */
  setMethod: (m: string) => void;
  /** 다시 그리라고 알린다. `heavy` 면 재료 캐시까지 버린다 (설정이 바뀌었을 때) */
  bump: (heavy?: "layers" | "all") => void;
};

/** 박스마다 붙는 씨앗 번호. ★줄지 않는다 — 지운 자리를 물려주면 구름이 딸려 온다 */
let boxSeq = 1;
export const nextSeed = () => boxSeq++;

let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanSeq = 0;

export const useCensor = create<S>((set, get) => ({
  ...load(),
  models: [],
  tab: "before",
  images: [],
  after: [],
  idx: -1,
  afterIdx: -1,
  boxes: {},
  sizes: {},
  src: null,
  renderer: null,
  rev: 0,
  tool: "select",
  sel: -1,
  editing: false,
  scanning: false,
  busy: false,
  progress: null,
  staged: false,
  error: null,

  set: (patch) => set(patch as S),

  cur() {
    const s = get();
    return s.tab === "after" ? s.after[s.afterIdx] : s.images[s.idx];
  },

  curBoxes() {
    const im = get().cur();
    return im ? (get().boxes[im.id] ?? []) : [];
  },

  putBoxes(b) {
    const im = get().cur();
    if (!im) return;
    set({ boxes: { ...get().boxes, [im.id]: b } });
    get().bump();
  },

  async loadModels() {
    const r = await api<{ models: CensorModel[] }>("/api/censor/models");
    const first = r.models[0];
    const keep = r.models.some((m) => m.file === get().model);
    const model = keep ? get().model : (first?.file ?? null);
    const classes = r.models.find((m) => m.file === model)?.classes ?? [];
    const targets = get().targets.filter((t) => classes.includes(t));
    set({
      models: r.models,
      model,
      // ★처음엔 **전부** 대상이다. 켜는 것을 잊어 아무것도 안 찾는 일이 없게
      targets: targets.length ? targets : classes,
      labelConf: fillConf(get().labelConf, classes, get().conf),
    });
  },

  setModel(file) {
    // ★모델마다 **클래스 이름이 다르다** (기본 nipples… / XL nipple·female face…).
    //   바꾸면 대상 목록도 그 모델 것으로 갈아 끼워야 한다. 안 그러면 아무것도 안 찾는다
    const classes = get().models.find((m) => m.file === file)?.classes ?? [];
    set({ model: file, targets: classes, labelConf: fillConf(get().labelConf, classes, get().conf), error: null });
    save(get());
    void get().scan();
  },

  setTab(t) {
    if (t === get().tab) return;
    set({ tab: t, sel: -1, tool: "select", renderer: null, src: null, error: null });
    const s = get();
    if (t === "after") s.select(s.afterIdx >= 0 ? s.afterIdx : 0);
    else s.select(s.idx >= 0 ? s.idx : 0);
  },

  tune(patch, redo) {
    set(patch as S);
    save(get());
    if (redo === "scan" && get().tab === "before") void get().scan();
    if (redo === "draw") {
      /* ★버릴 캐시를 **바뀐 값에 맞춰** 고른다. 「부드럽게」만 구름 무늬까지 다시 만들고,
         나머지는 재료만 다시 만든다. 이 구분이 슬라이더를 끄는 손맛을 정한다. */
      const keys = Object.keys(patch);
      const heavy = keys.includes("feather") ? "all" : "layers";
      get().bump(heavy);
    }
  },

  toggleTarget(label) {
    const t = get().targets;
    get().tune({ targets: t.includes(label) ? t.filter((x) => x !== label) : [...t, label] }, "scan");
  },

  setLabelConf(label, v) {
    get().tune({ labelConf: { ...get().labelConf, [label]: v } }, "scan");
  },

  async addImages(items) {
    if (!items.length) return;
    const base = await backendUrl();
    // 목록에 그릴 작은 그림·크기는 서버가 준다. 앱에는 경로만 오므로 화면이 못 읽는다
    let probed: { thumb?: string; width?: number; height?: number }[] = [];
    try {
      const r = await post<{ items: { thumb?: string; width?: number; height?: number }[] }>(
        "/api/tools/probe",
        { items: items.map((it) => ({ name: it.name, rel: it.rel, path: it.path, data: it.data })) },
      );
      probed = r.items;
    } catch {}
    const cur = get().images;
    const have = new Set(cur.map((x) => x.rel ?? x.path ?? x.name));
    const add: CensorImage[] = [];
    items.forEach((it, i) => {
      const key = it.rel ?? it.path ?? it.name;
      if (have.has(key)) return;
      have.add(key);
      add.push({
        id: `c${seq++}`,
        name: it.name,
        rel: it.rel,
        path: it.path,
        data: it.data,
        thumb: probed[i]?.thumb || (it.rel ? undefined : undefined),
        w: probed[i]?.width,
        h: probed[i]?.height,
      });
    });
    if (!add.length) return;
    void base;
    const images = [...cur, ...add];
    // 담은 것이 늘면 「전체 검열」을 다시 돌려야 한다. 새 장에는 아직 박스가 없다
    set({ images, staged: false });
    if (get().tab === "before") get().select(images.indexOf(add[0]));
  },

  /** 파일 트리 격자에서 누르면 목록에 담고, 다시 누르면 뺀다 */
  toggleRel(rel, name) {
    const at = get().images.findIndex((x) => x.rel === rel);
    if (at >= 0) return get().removeImage(at);
    void get().addImages([{ name, rel }]);
  },

  removeImage(i) {
    const s = get();
    if (s.tab === "after") return;
    const images = s.images.filter((_, n) => n !== i);
    const idx = images.length ? Math.min(s.idx > i ? s.idx - 1 : s.idx, images.length - 1) : -1;
    set({ images, idx: -1 });
    // ★인덱스를 한 번 -1 로 떨어뜨린 뒤 다시 고른다. 같은 번호에 다른 그림이 오면
    //   select 가 "이미 그 자리"라고 보고 아무것도 안 한다
    if (idx >= 0) get().select(idx);
    else set({ src: null, renderer: null, idx: -1 });
  },

  clearImages() {
    scanSeq++;
    set({ images: [], idx: -1, src: null, renderer: null, boxes: {}, scanning: false, staged: false, error: null });
  },

  select(i) {
    const s = get();
    const list = s.tab === "after" ? s.after : s.images;
    if (i < 0 || i >= list.length) return set({ src: null, renderer: null, sel: -1 });
    const im = list[i];
    set(s.tab === "after" ? { afterIdx: i } : { idx: i });
    set({ sel: -1, renderer: null, error: null });
    // ★그림을 **비트맵으로** 들여야 캔버스가 그린다. 주소만으로는 못 그린다
    void loadRenderer(im).then(({ src, renderer, size }) => {
      // 넘기는 사이에 다른 장으로 갔으면 버린다
      if (get().cur()?.id !== im.id) return;
      set({ src, renderer, rev: get().rev + 1 });
      if (size && !get().sizes[im.id]) set({ sizes: { ...get().sizes, [im.id]: size } });
    }).catch((e) => {
      if (get().cur()?.id === im.id) set({ error: String(e) });
    });
    prefetch(list, i);
    if (s.tab === "before" && !get().boxes[im.id]) void get().scan();
  },

  step(d) {
    const s = get();
    const list = s.tab === "after" ? s.after : s.images;
    const at = s.tab === "after" ? s.afterIdx : s.idx;
    const next = at + d;
    if (next >= 0 && next < list.length) s.select(next);
  },

  async scan() {
    const s = get();
    const im = s.cur();
    if (!im || s.tab !== "before" || !s.model) return;
    if (!s.targets.length) return set({ boxes: { ...s.boxes, [im.id]: [] } });
    if (scanTimer) clearTimeout(scanTimer);
    const mine = ++scanSeq;
    set({ scanning: true });
    scanTimer = setTimeout(() => {
      void (async () => {
        try {
          const r = await post<{ detections: Box[]; width: number; height: number }>("/api/censor/detect", {
            ...sourceOf(im),
            model: s.model,
            targets: s.targets,
            label_conf: s.labelConf,
            default_conf: s.conf,
            // ★문턱 미달도 받아 온다. 화면의 「낮은 신뢰도 숨김」이 다시 거른다.
            //   문턱을 올렸다 내릴 때마다 다시 찾지 않아도 된다
            return_all: true,
          });
          if (mine !== scanSeq) return;
          set({
            // ★찾은 자리마다 씨앗을 하나씩 붙인다 (구름이 옮겨도 안 바뀌게)
            boxes: { ...get().boxes, [im.id]: r.detections.map((d) => ({ ...d, seed: nextSeed() })) },
            sizes: { ...get().sizes, [im.id]: { w: r.width, h: r.height } },
            error: null,
          });
        } catch (e) {
          if (mine === scanSeq) set({ error: String(e) });
        } finally {
          if (mine === scanSeq) set({ scanning: false });
        }
      })();
    }, 250);
  },

  /** 전체 검열. 담아 둔 것을 **전부 찾아** 검열 중 탭으로 넘긴다 (v2 `runBatchCensor`).
   *
   *  ★이미 찾아 둔 장은 **다시 찾지 않는다.** v2 는 전부 새로 돌려서, 검열 전 탭에서
   *    꺼 둔 오탐이 되살아났다 (장당 0.4초·XL 은 4초라 기다림도 그만큼 길었다). */
  async scanAll() {
    const s = get();
    if (s.busy || !s.images.length || !s.model) return;
    if (!s.targets.length) return set({ error: t("censor.needTarget") });
    set({ busy: true, error: null, progress: { done: 0, total: s.images.length, what: "scan" } });
    const boxes = { ...s.boxes };
    const sizes = { ...s.sizes };
    for (let i = 0; i < s.images.length; i++) {
      const im = s.images[i];
      try {
        if (!boxes[im.id]) {
          const r = await post<{ detections: Box[]; width: number; height: number }>("/api/censor/detect", {
            ...sourceOf(im),
            model: s.model,
            targets: s.targets,
            label_conf: s.labelConf,
            default_conf: s.conf,
            return_all: true,
          });
          boxes[im.id] = r.detections.map((d) => ({ ...d, seed: nextSeed() }));
          sizes[im.id] = { w: r.width, h: r.height };
        }
        // 검열 중 탭에서 고칠 것이므로 지금 방식을 박스마다 박아 둔다 (박스별로 바꿀 수 있게)
        boxes[im.id] = boxes[im.id]
          .filter((b) => !b.off && passes(b, s.labelConf, s.conf))
          .map((b) => ({ ...b, method: b.method ?? s.method }));
      } catch (e) {
        boxes[im.id] = boxes[im.id] ?? [];
        set({ error: String(e) });
      }
      set({ progress: { done: i + 1, total: s.images.length, what: "scan" } });
    }
    set({ boxes, sizes, busy: false, progress: null, staged: true });
    get().setTab("processing");
  },

  /** 일괄 저장. ★**박스가 0개인 장도 저장한다**. 결과 폴더가 원본 묶음의 대역이 되어야 한다 */
  async saveAll() {
    const s = get();
    if (s.busy || !s.images.length) return;
    set({ busy: true, error: null, progress: { done: 0, total: s.images.length, what: "save" } });
    const made: CensorImage[] = [];
    for (let i = 0; i < s.images.length; i++) {
      const im = s.images[i];
      try {
        /* ★★**화면이 굽는다.** 지금 보고 있지 않은 장도 여기서 원본 크기로 한 장 그린다
           (`renderOne`). 서버는 받은 바이트를 적기만 한다 — 렌더러가 한 벌이라
           보고 있던 그림과 저장본이 갈릴 수 없다. */
        const blob = await renderOne(im, liveBoxes(get().boxes[im.id] ?? []), coverOf(get()));
        const r = await post<{ file: string; name: string }>("/api/censor/apply", {
          ...sourceOf(im),
          name: im.name,
          ...destOf(get(), s.images),
          image: await blobToBase64(blob),
        });
        made.push({ id: `a${seq++}`, name: r.name, rel: r.file });
      } catch (e) {
        set({ error: String(e) });
      }
      set({ progress: { done: i + 1, total: s.images.length, what: "save" } });
    }
    set({ after: made, afterIdx: -1, busy: false, progress: null, staged: false });
    get().setTab("after");
  },

  /** 검열 후 탭에서 한 장을 다시 저장한다 (v2 `saveAfterEdit`) */
  async saveOne() {
    const s = get();
    const im = s.cur();
    if (!im || s.busy) return;
    const boxes = liveBoxes(s.boxes[im.id] ?? []);
    if (!boxes.length) return set({ error: t("censor.needBox") });
    set({ busy: true, error: null });
    try {
      // ★지금 보고 있는 장이라 렌더러가 이미 있다. 그것으로 원본 크기 한 장을 굽는다
      const r0 = s.renderer;
      const blob = r0 ? await r0.renderFull(boxes, coverOf(s)) : await renderOne(im, boxes, coverOf(s));
      const r = await post<{ file: string; name: string }>("/api/censor/apply", {
        ...sourceOf(im),
        name: im.name,
        ...destOf(s, [im]),
        image: await blobToBase64(blob),
      });
      const made: CensorImage = { id: `a${seq++}`, name: r.name, rel: r.file };
      set({ after: [...get().after, made], boxes: { ...get().boxes, [im.id]: [] } });
      get().select(get().after.length - 1);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  cancelProcessing() {
    set({ tab: "before", sel: -1, tool: "select", staged: false, error: null });
    get().select(get().idx >= 0 ? get().idx : 0);
  },

  addBox(box) {
    const s = get();
    const im = s.cur();
    if (!im) return;
    const cur = s.boxes[im.id] ?? [];
    // ★`label` 은 **저장되는 값**이라 번역문을 넣지 않는다. 화면 글자는 `manual` 을 보고 고른다
    //   (`CensorStage`) — 여기 한국어를 박아 두면 세 언어 어디서나 그 글자가 뜬다.
    s.putBoxes([...cur, { label: "manual", confidence: 1, box, manual: true, method: s.method, seed: nextSeed() }]);
    set({ sel: cur.length });
  },

  removeBox(i) {
    const s = get();
    s.putBoxes(s.curBoxes().filter((_, n) => n !== i));
    set({ sel: -1 });
  },

  toggleBox(i) {
    const s = get();
    s.putBoxes(s.curBoxes().map((b, n) => (n === i ? { ...b, off: !b.off } : b)));
  },

  setBoxMethod(i, m) {
    const s = get();
    s.putBoxes(s.curBoxes().map((b, n) => (n === i ? { ...b, method: m } : b)));
  },

  /** ★★방식을 바꾸면 **지금 있는 박스에 전부 걸린다** (사용자 지시 2026-08-23).
   *
   *  박스는 만들 때의 방식을 **자기가 들고 있다** (`addBox` — 박스마다 다르게 할 수 있어야
   *  하므로). 그래서 예전에는 검열 중에 방식을 바꿔도 **다음에 그릴 박스에만** 반영돼,
   *  화면은 그대로인 채 단추만 옮겨 갔다.
   *  ★검열 전 탭에서는 안 건다 — 거기 박스는 아직 「찾은 것」이고, 방식은 다음 검열의 값이다.
   *  ★박스마다 따로 고르는 길은 그대로다 (`setBoxMethod`) — 전체를 바꾼 뒤에 하나만 달리 둘 수 있다. */
  setMethod(m) {
    const s = get();
    if (s.tab === "processing") {
      /* ★★검열 중이면 **모든 그림**의 박스에 건다 (v2 `censorMethod.onchange`, 카탈로그 5039).
         지금 그림만 바꾸면 앞서 찾아 둔 나머지는 **옛 방식으로 저장된다** — 저장하고 나서야
         드러나는 조용한 회귀라, 카탈로그가 그 함정을 따로 적어 두었다. */
      const next: Record<string, Box[]> = { ...s.boxes };
      for (const im of s.images) {
        const cur = next[im.id];
        if (cur?.length) next[im.id] = cur.map((b) => ({ ...b, method: m }));
      }
      set({ boxes: next });
    } else if (s.tab === "after" && s.cur()) {
      // ★검열 후에는 **지금 그림만** — 이미 저장된 다른 장을 건드릴 이유가 없다 (v2 와 같다)
      s.putBoxes(s.curBoxes().map((b) => ({ ...b, method: m })));
    }
    // ★검열 전 탭에서는 박스에 안 건다 — 거기 박스는 「찾은 것」이고 방식은 다음 검열의 값이다
    s.tune({ method: m }, "draw");
  },

  /** 다시 그리라고 알린다. 무대가 `rev` 를 보고 캔버스를 새로 그린다.
   *
   *  ★★여기서 **아무것도 계산하지 않는다.** 박스를 끄는 동안 일어나는 일은 숫자 하나가
   *    오르는 것뿐이고, 실제 그리기는 무대가 `CensorRenderer` 로 그 자리에서 한다.
   *  ★`heavy` 는 캐시를 어디까지 버릴지다:
   *      (없음)   모양만 바뀌었다 — 재료를 그대로 쓴다 (가장 잦고, 가장 싸다)
   *      layers   방식·모자이크·흐리기·색·넓히기가 바뀌었다 — 재료를 다시 만든다
   *      all      「부드럽게」가 바뀌었다 — 구름 무늬까지 다시 만든다
   */
  bump(heavy) {
    const r = get().renderer;
    if (r && heavy === "all") r.invalidateAll();
    else if (r && heavy === "layers") r.invalidate();
    set({ rev: get().rev + 1 });
  },
}));

/** 이 박스가 **문턱을 넘었나.** ★저장된 `passes_threshold` 를 그대로 믿지 않는다.
 *  찾은 뒤에 클래스별 문턱을 고쳤으면 그 값은 옛것이다. 지금 설정으로 다시 판정한다. */
export const passes = (b: Box, labelConf: Record<string, number>, conf: number) =>
  !!b.manual || b.confidence >= (labelConf[b.label] ?? conf);

/** 새 클래스에는 지금 문턱을 채워 준다 (v2 는 0.3 을 박아 뒀다. 여기서는 공통 문턱을 쓴다) */
function fillConf(cur: Record<string, number>, classes: string[], base: number) {
  const out = { ...cur };
  for (const c of classes) if (!(c in out)) out[c] = base;
  return out;
}

function save(s: Saved) {
  const { model, targets, labelConf, conf, floor, method, color, expand, feather, mosaic,
    mosaicOpacity, blur, steamBright, steamAlpha, peek, dest } = s;
  try {
    localStorage.setItem(KEY, JSON.stringify({ model, targets, labelConf, conf, floor, method,
      color, expand, feather, mosaic, mosaicOpacity, blur, steamBright, steamAlpha, peek, dest }));
  } catch {}
}

/** 실제로 가릴 박스만. 끈 것은 뺀다.
 *  ★씨앗이 없는 것(옛 자리에서 온 것)은 **자리로 만들지 않는다** — 그러면 옮길 때 또 바뀐다.
 *    번호를 그 자리에서 새로 발급해 붙인다. */
export const liveBoxes = (b: Box[]): RenderBox[] =>
  b
    .filter((x) => !x.off)
    .map((x) => ({
      box: x.box.map((v) => Math.round(v)) as [number, number, number, number],
      method: x.method,
      rotation: x.rotation ?? 0,
      seed: x.seed ?? (x.seed = nextSeed()),
    }));

/** 가리는 방법 한 벌. **화면과 저장이 같은 값을 지난다** (렌더러가 한 벌이므로) */
export function coverOf(s: Saved): CoverSettings {
  return {
    method: s.method,
    color: s.color,
    expand: s.expand,
    feather: s.feather,
    mosaic: s.mosaic,
    mosaicOpacity: s.mosaicOpacity,
    blur: s.blur,
    steamBright: s.steamBright,
    steamAlpha: s.steamAlpha,
  };
}

/** 무대에 그릴 주소. 아웃풋 안의 그림은 그대로 가리키고, 밖의 것은 서버에서 한 번 받는다.
 *
 *  ★떨군 그림은 **원본 그대로** 온다 (`/api/censor/image`). 줄여 받으면 저장할 때 그 크기로
 *    구워져 원본보다 작은 그림이 나온다. */
async function resolveSrc(im: CensorImage): Promise<{ src: string; size?: { w: number; h: number } }> {
  const hit = cacheGet(im.id);
  if (hit) return { src: hit, size: im.w && im.h ? { w: im.w, h: im.h } : undefined };
  if (im.rel) {
    /* ★★**바이트를 받아 `blob:` 주소로 쓴다.** 백엔드는 화면과 다른 오리진이라, 그 주소를
       그대로 캔버스에 그리면 캔버스가 **오염**되어 `toBlob` 이 막힌다 — 즉 저장이 통째로
       안 된다 (실측 2026-08-23). `crossOrigin="anonymous"` 로도 되지만, 같은 주소를
       한쪽은 켜고 한쪽은 끄면 **브라우저 캐시가 어긋나 그림이 아예 안 뜬다** (이것도 실측).
       blob 주소는 언제나 같은 오리진이라 그 함정이 처음부터 없다. */
    const res = await fetch(fileMgrImg(await backendUrl(), im.rel));
    if (!res.ok) throw new Error(`그림을 못 읽었습니다 (${res.status})`);
    const src = URL.createObjectURL(await res.blob());
    cacheSet(im.id, src);
    return { src };
  }
  const r = await post<{ image: string; width: number; height: number }>("/api/censor/image", sourceOf(im));
  cacheSet(im.id, r.image);
  im.w = r.width;
  im.h = r.height;
  return { src: r.image, size: { w: r.width, h: r.height } };
}

/** 그 그림의 **렌더러**를 만든다 (비트맵을 들여야 캔버스가 그린다).
 *
 *  ★`decode()` 를 기다린다 — 안 기다리고 그리면 첫 프레임이 빈 캔버스로 나간다. */
async function loadRenderer(im: CensorImage) {
  const { src, size } = await resolveSrc(im);
  const el = new Image();
  el.src = src;
  await el.decode();
  const w = size?.w ?? el.naturalWidth;
  const h = size?.h ?? el.naturalHeight;
  return { src, size: { w, h }, renderer: new CensorRenderer(el, w, h) };
}

/** 저장할 때 쓰는 렌더러 — 일괄 저장은 **화면에 없는 장**도 구워야 한다.
 *  ★들고 있지 않는다. 한 장 굽고 버린다 (수십 장의 비트맵을 동시에 쥐면 메모리가 는다). */
export async function renderOne(im: CensorImage, boxes: RenderBox[], s: CoverSettings) {
  const { renderer } = await loadRenderer(im);
  return await renderer.renderFull(boxes, s);
}

/** 캔버스가 구운 것을 서버가 받을 수 있는 base64 로 */
export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 좌우 세 장을 미리 받아 둔다 (v2 `prefetchCensorImages`) */
function prefetch(list: CensorImage[], at: number) {
  for (let d = 1; d <= 3; d++) {
    for (const i of [at + d, at - d]) {
      const im = list[i];
      if (!im || srcCache.has(im.id)) continue;
      void resolveSrc(im).then(({ src }) => {
        // 브라우저 캐시에도 올려 둔다. 넘기는 순간 다시 내려받지 않게
        const img = new Image();
        img.src = src;
      });
    }
  }
}
