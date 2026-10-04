import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { toast } from "../store/toast";
import { ask } from "../store/ask";
import { useUi } from "../store/ui";
import { canPan, centerPan, clampPan, drawSize, keepCenter, stepZoom, zoomFrom, ZOOM_MAX, ZOOM_MIN, type Pan, type Size } from "../lib/zoomView";
import { boxInside, brushScale, centerOf, cornersOf, docToLayer, hitLayer, keepAnchor, normRect, rad, rectFrom, resizeCursor, type Rect } from "./model";
import { bubbleText, clipOf, composite, fontOf, makeCanvas, onFxReady, strokeTo, textLayout, type Layer, type Stroke } from "./pixels";
import {
  bboxOf, bendFrom, bendHandle, bendable, castNumbers, comicGroupId, distToEdge, genOf, hasTails, pageLabel, panelNumbers, panelPts, pointInPoly, rectPts,
  segHitsPoly, snapCands, snapTo, splitPoly, gapFor, tailGeo, WHO_BUBBLE, WHO_NARRATION,
  CAST_NEUTRAL, type Pt,
} from "./comic";
import { curCut, curPage, pageView, primaryOf, useEditor, type Doc } from "./store";
import { runningPendingId, stepKey, useQueue } from "../store/queue";
import { useWs } from "../store/workspace";
import { CAST_COLORS } from "./comicUi";

/** 무대 — 캔버스를 합성해 보여 주고, 도구에 따라 **누르고 끄는 것**을 받는다.
 *
 *  두 층이다: 이 **호스트**(판 재기 · 배율 · 끌어 보기 · 휠 · 바깥 누르기)와 **페이지**(`PageView` — 합성 캔버스 · 조작 SVG · 글 상자).
 *  보통 캔버스는 페이지가 하나이고, ★★만화 캔버스는 페이지 여럿이 **위에서 아래로** 쌓인다 (사용자 지시 2026-09-28:
 *  대부분의 환경에서 아래로 스크롤하며 본다). 맨 아래에 「+ 페이지」가 페이지 폭으로 선다. 휠이 곧 위아래 스크롤이다.
 *  ★★획을 긋는 동안은 리액트를 안 거친다 — `strokeRef` 에 모아 두고 프레임마다 `paint()` 가 스토어를 `getState()` 로
 *    읽어 그린다. 손을 떼면 `endStroke` 가 한 걸음 적는다.
 *  ★배율·자리 계산은 전부 `lib/zoomView` (검열·생성 쪽과 같은 함수). `fit` 이면 판 안에 **한 페이지**를 맞추고(작은 그림은
 *    안 키운다), 배율을 정하면 넘치는 만큼 끌어 본다.
 *  ★붓 값은 `useUi.editorBrush` — 브러시와 지우개가 **따로** 기억된다 (사용자 지시 2026-09-22). */
/** 회전 손잡이 위의 커서 — CSS 에 회전 커서가 없어 SVG(굽은 화살표, 검은 테두리에 흰 선)를 그려 넣는다. 가운데가 핫스팟 */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>"
  + "<path d='M19 12a7 7 0 1 1-2.05-4.95M17 3v4.2h-4.2' stroke='#000' stroke-width='3.6'/>"
  + "<path d='M19 12a7 7 0 1 1-2.05-4.95M17 3v4.2h-4.2' stroke='#fff' stroke-width='1.6'/></svg>",
)}") 11 11, auto`;

/** 만화 캔버스의 페이지 쌓기 — 페이지 머리(`p.01`) 자리 · 페이지 사이 · 「+ 페이지」 높이 (화면 px, 배율과 무관) */
const LB = 22;
const GAP = 26;
const ADD_H = 40;

export function Stage({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const bg = useUi((s) => s.editorBg);
  const tool = useEditor((s) => s.tool);
  const reveal = useEditor((s) => s.reveal);
  const busyPage = useEditor((s) => s.contiBusy === doc.id);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const comic = doc.comic ?? null;
  const pages = comic ? comic.pages : [null];
  const n = pages.length;
  /** 한 페이지를 맞출 자리 — 만화는 페이지 머리·여백을 뺀다 */
  const fitBox = comic ? { w: Math.max(1, box.w - 24), h: Math.max(1, box.h - LB - 16) } : box;
  const k = zoomFrom(fitBox, doc, doc.view.fit, doc.view.zoom);
  const fitK = doc.view.fit ? Math.min(k, 1) : k;
  const fitted = { w: Math.max(1, Math.floor(doc.w * fitK)), h: Math.max(1, Math.floor(doc.h * fitK)) };
  /** 페이지 하나가 차지하는 높이 (머리 포함) · 쌓인 전체 크기 */
  const slot = comic ? LB + fitted.h + GAP : 0;
  const content: Size = comic ? { w: fitted.w, h: n * slot + ADD_H } : fitted;
  const topOf = (i: number) => i * slot + (comic ? LB : 0);
  const movable = comic ? canPan(box, content) : !doc.view.fit && canPan(box, fitted);
  const scale = fitted.w / doc.w || 1;

  /* ── 판 재기 ── */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => setBox((b) => (b.w === host.clientWidth && b.h === host.clientHeight ? b : { w: host.clientWidth, h: host.clientHeight }));
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    fit();
    return () => ro.disconnect();
  }, []);
  /** 그 페이지의 머리가 판 위쪽에 오게 (만화) */
  const panTo = useCallback(
    (i: number) => setPan((p) => clampPan({ x: p.x, y: 12 - (topOf(i) - (comic ? LB : 0)) }, box, content)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [box.w, box.h, content.w, content.h, slot],
  );
  // 캔버스가 바뀌면 가운데(만화는 지금 페이지)에서 시작한다
  useEffect(() => {
    if (!box.w || !box.h) return;
    if (!comic) return setPan(centerPan(box, fitted));
    const c = centerPan(box, content);
    const i = Math.max(0, comic.pages.indexOf(curPage(doc) ?? ""));
    setPan(clampPan({ x: c.x, y: 12 - topOf(i) + LB }, box, content));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, box.w, box.h]);
  useEffect(() => {
    setPan((p) => clampPan(p, box, comic ? content : fitted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.w, box.h, content.w, content.h, fitted.w, fitted.h]);
  // ★페이지로 가라는 요청 — 「+ 페이지」 · 컷 줄의 페이지 고르기 · AI 콘티가 깐 페이지 (`useEditor.reveal`)
  useEffect(() => {
    if (!reveal || reveal.doc !== doc.id || !comic) return;
    const i = comic.pages.indexOf(reveal.page);
    if (i >= 0) panTo(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n]);

  /* ── 휠: Ctrl 확대·축소 · Alt 붓 크기 (지금 도구의 것) · 만화는 그냥 휠이 위아래 스크롤 ── */
  const viewRef = useRef({ box, content, fitted, comic: !!comic, fitBox });
  viewRef.current = { box, content, fitted, comic: !!comic, fitBox };
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s = useEditor.getState();
        const d = s.doc();
        if (!d) return;
        const from = zoomFrom(v.fitBox, d, d.view.fit, d.view.zoom);
        const fromK = d.view.fit ? Math.min(from, 1) : from;
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepZoom(fromK, e.deltaY > 0 ? -1 : 1)));
        const r = next / fromK;
        const to = v.comic ? { w: v.content.w * r, h: (v.content.h - ADD_H) * r + ADD_H } : drawSize(d, next);
        setPan((p) => keepCenter(p, v.box, v.comic ? v.content : drawSize(d, fromK), to));
        s.setView({ fit: false, zoom: next });
        return;
      }
      if (e.altKey) {
        e.preventDefault();
        const which = useEditor.getState().tool === "eraser" ? "eraser" : "brush";
        const ui = useUi.getState();
        const step = (e.shiftKey ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
        ui.setEditorBrush(which, { size: Math.max(1, Math.min(400, ui.editorBrush[which].size + step)) });
        return;
      }
      if (v.comic) {
        e.preventDefault();
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        setPan((p) => clampPan({ x: p.x - dx, y: p.y - dy }, v.box, v.content));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** 캔버스 **밖**(무대의 빈 바탕)을 눌러도 선택을 푼다 — 안의 빈 자리를 눌렀을 때와 같다 (사용자 지시 2026-09-22).
   *  ★캔버스 위의 누르기도 여기까지 올라오므로 **바탕 자체**를 누른 것만 받는다.
   *  ★끌어 고르기는 **캔버스 밖에서 시작해도 된다** (보통 캔버스) — 배경 레이어가 캔버스를 다 덮으므로 안에는 빈 자리가 없다.
   *    뒤의 움직임·놓기는 조작 SVG 의 `move`·`up` 이 받도록 포인터를 거기에 잡아 둔다. 만화는 페이지가 여럿이라 선택만 푼다 */
  const outsideRef = useRef<((e: React.PointerEvent) => void) | null>(null);
  const downOutside = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget || e.button !== 0) return;
    if (e.button === 0 && tool === "pan" && movable) return startPan(e);
    if (tool !== "select") return;
    e.preventDefault();
    const multi = e.ctrlKey || e.metaKey;
    if (!multi && doc.sel.length) useEditor.getState().selectLayer(null);
    if (!comic) outsideRef.current?.(e);
  };
  /** 끌어 보기 (가운데 단추 · 이동 도구) — 페이지가 넘길 때와 바탕을 누를 때 같은 것을 쓴다 */
  const panDrag = useRef<{ x: number; y: number; p0: Pan } | null>(null);
  const startPan = (e: React.PointerEvent) => {
    e.preventDefault();
    panDrag.current = { x: e.clientX, y: e.clientY, p0: pan };
    hostRef.current?.setPointerCapture(e.pointerId);
  };
  const movePan = (e: { clientX: number; clientY: number }) => {
    const d = panDrag.current;
    if (!d) return false;
    setPan(clampPan({ x: d.p0.x + (e.clientX - d.x), y: d.p0.y + (e.clientY - d.y) }, box, comic ? content : fitted));
    return true;
  };

  /* ── 스크롤 막대 (만화) — 보이는 만큼 / 전체. 끌 수 있다 ── */
  const barDrag = useRef<{ y: number; p0: number } | null>(null);
  const seen = comic && content.h > box.h ? box.h / content.h : 1;
  const barH = Math.max(28, box.h * seen);
  const barTop = seen < 1 ? ((-pan.y) / Math.max(1, content.h - box.h)) * (box.h - barH) : 0;

  const bgStyle: React.CSSProperties =
    bg === "light" ? { background: "#4a4a55" }
      : bg === "checker" ? { background: "conic-gradient(#8a8a94 25%, #5c5c66 0 50%, #8a8a94 0 75%, #5c5c66 0) 0 0/16px 16px" }
        : bg.startsWith("#") ? { background: bg }
          : { background: "var(--bg)" };

  /** 보이는 페이지만 새로 그린다 — 화면 밖 페이지는 들어올 때 그린다 (페이지가 여럿이면 매 걸음 전부 굽기엔 무겁다) */
  const visible = (i: number) => {
    if (!comic) return true;
    const top = pan.y + topOf(i);
    return top + fitted.h > -200 && top < box.h + 200;
  };
  const cur = comic ? curPage(doc) : null;

  return (
    <div
      ref={hostRef}
      data-editor-stage
      data-editor-pages={comic ? n : undefined}
      onPointerDown={downOutside}
      onPointerMove={(e) => void movePan(e)}
      onPointerUp={() => { panDrag.current = null; }}
      onPointerCancel={() => { panDrag.current = null; }}
      style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", border: "1px solid var(--line)", borderRadius: "var(--r-3)", cursor: tool === "pan" && movable ? "move" : undefined, ...bgStyle }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: content.w,
          height: content.h,
          transform: `translate(${pan.x}px, ${pan.y}px)`,
          pointerEvents: "none",
        }}
      >
        {pages.map((pid, i) => {
          const view = pid ? pageView(doc, pid) : doc;
          return (
            <div key={pid ?? "one"} style={{ position: "absolute", left: 0, top: topOf(i), width: fitted.w, height: fitted.h, pointerEvents: "auto" }}>
              {pid && (
                <span
                  data-editor-page-label={i + 1}
                  data-on={pid === cur ? "" : undefined}
                  style={{ position: "absolute", left: 0, top: -LB + 3, fontSize: "var(--text-3xs)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
                           color: pid === cur ? "#fff" : "rgba(255,255,255,.5)", fontWeight: pid === cur ? "var(--w-semi)" : "var(--w-normal)" }}
                >
                  {pageLabel(i)}
                </span>
              )}
              <PageView
                doc={view}
                pid={pid}
                fitted={fitted}
                scale={scale}
                visible={visible(i)}
                movable={movable}
                onPanStart={startPan}
                outsideRef={i === 0 ? outsideRef : undefined}
              />
            </div>
          );
        })}
        {comic && busyPage && (
          <div
            data-editor-page-busy
            style={{ position: "absolute", left: 0, top: topOf(n) - LB, width: fitted.w, height: ADD_H, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                     borderRadius: "var(--r-2)", background: "rgba(244,244,247,.9)", color: "#7a7a86", fontSize: "var(--text-2xs)", pointerEvents: "auto" }}
          >
            <span className="busy-spin" style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid rgba(58,123,184,.25)", borderTopColor: "#3a7bb8" }} />
            {t("editor.contiMaking")}
          </div>
        )}
        {comic && !busyPage && (
          <button
            data-editor-page-add
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              const s = useEditor.getState();
              const pid = s.addPage(comic.pages[comic.pages.length - 1]);
              if (pid) s.revealPage(pid);
            }}
            style={{
              position: "absolute", left: 0, top: topOf(n) - LB, width: fitted.w, height: ADD_H, pointerEvents: "auto",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              border: "1.5px dashed rgba(255,255,255,.28)", borderRadius: "var(--r-2)", color: "rgba(255,255,255,.62)", fontSize: "var(--text-3xs)", background: "transparent",
            }}
          >
            {Icon.plus}{t("editor.pageAdd")}
          </button>
        )}
      </div>
      {comic && seen < 1 && (
        <span
          data-editor-vbar
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            barDrag.current = { y: e.clientY, p0: pan.y };
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = barDrag.current;
            if (!d) return;
            const dy = ((e.clientY - d.y) / Math.max(1, box.h - barH)) * (content.h - box.h);
            setPan((p) => clampPan({ x: p.x, y: d.p0 - dy }, box, content));
          }}
          onPointerUp={() => { barDrag.current = null; }}
          style={{ position: "absolute", right: 3, top: barTop, width: 6, height: barH, borderRadius: 3, background: "rgba(255,255,255,.26)", cursor: "default" }}
        />
      )}
    </div>
  );
}

/** 페이지 한 장 — 합성 캔버스 · 조작 SVG(손잡이·자르기 상자·붓 커서·만화 표시) · 글 상자(글자를 고치는 동안).
 *  `doc` 은 **그 페이지만 담은 문서**(`pageView`)다 — 누르기 판정·손잡이·컷 번호가 저절로 그 페이지 것만 본다.
 *  ★만화 캔버스에서 이 페이지를 누르면 먼저 지금 페이지가 이 페이지로 바뀐다 (새 글자·말풍선·효과음·컷이 여기에 든다). */
function PageView({ doc, pid, fitted, scale, visible, movable, onPanStart, outsideRef }: {
  doc: Doc;
  pid: string | null;
  fitted: Size;
  scale: number;
  visible: boolean;
  movable: boolean;
  onPanStart: (e: React.PointerEvent) => void;
  outsideRef?: React.MutableRefObject<((e: React.PointerEvent) => void) | null>;
}) {
  const t = useI18n((s) => s.t);
  const tool = useEditor((s) => s.tool);
  const ratioLock = useEditor((s) => s.ratioLock);
  const crop = useEditor((s) => s.crop);
  const textEdit = useEditor((s) => s.textEdit);
  const brushes = useUi((s) => s.editorBrush);
  const brush = tool === "eraser" ? brushes.eraser : brushes.brush;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  /** 끌어 고르기 상자 (문서 좌표, 캔버스 밖도 된다) */
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** 컷 도구 — 자르기선(끄는 중) · 새 컷 상자(빈 자리에서 끄는 중) */
  const [cutLine, setCutLine] = useState<{ ids: string[]; a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [newRect, setNewRect] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /** 선택 도구에서 커서 아래에 있는 것의 커서 모양 — 손잡이면 크기·회전 커서, 레이어면 move, 없으면 null (사용자 지시 2026-09-22) */
  const [hoverCur, setHoverCur] = useState<string | null>(null);
  /** 긋는 중 */
  const strokeRef = useRef<{ st: Stroke; last: { x: number; y: number } | null; layer: Layer } | null>(null);
  /** 손잡이를 끄는 중 */
  const dragRef = useRef<{
    kind: "move" | "scale" | "rotate" | "crop" | "marquee" | "vertex" | "cut" | "body" | "tip" | "bend" | "cast";
    start: { x: number; y: number };
    layer?: Layer;
    /** 함께 옮기는 것들 (끌기 시작 때의 자리) */
    layers?: Layer[];
    /** 끌어 고르기가 얹히는 바탕 — Ctrl 로 시작했으면 그때 골라 둔 것 */
    base?: string[];
    handle?: { sx: -1 | 0 | 1; sy: -1 | 0 | 1 };
    rot0?: number;
    ang0?: number;
    /** 이력에 「끌기 전」을 적었나 — 처음 움직일 때 한 번 (클릭만 하고 놓으면 걸음이 안 생긴다) */
    marked?: boolean;
    /** 컷 꼭짓점 끌기 — 몇 번째 꼭짓점 · 끌기 전 다각형 */
    vi?: number;
    poly0?: Pt[];
    /** 말풍선 꼬리 — 몇 번째 꼬리 */
    ti?: number;
    /** 인물 점 — 그 칸의 key */
    key?: string;
    /** 말풍선을 눌렀다 놓기만 하면 글 고치기 (말풍선 도구) */
    tapEdit?: boolean;
  } | null>(null);
  const rafRef = useRef(0);
  /** 선택 도구의 더블클릭 셈 — 바로 앞의 누르기 (pointerdown 의 기본 동작을 막으면 호환 dblclick 이 안 와서 직접 센다) */
  const dblRef = useRef<{ t: number; x: number; y: number } | null>(null);

  /* ── 그리기 ── */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const s = useEditor.getState();
    const full = s.doc();
    if (!full) return;
    const d = pid ? pageView(full, pid) : full;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const kk = (cv.clientWidth / d.w) * dpr || 1;
    const st = strokeRef.current?.st ?? null;
    // 글자 레이어는 고치는 동안 합성에서 뺀다 (말풍선은 글을 뺀 채로 구워 두므로 그대로 그린다)
    const te = s.textEdit;
    const skip = te && d.layers.find((l) => l.id === te.id)?.text ? te.id : null;
    // ★효과는 워커가 셈하는 동안 앞의 결과로 그리고(`live`), 다 되면 다시 그린다 (`onFxReady`)
    composite(d, cv, kk, { sel: primaryOf(d), stroke: st, skip, live: true });
  }, [pid]);
  // ★페이지의 레이어가 **바뀌었을 때만** 다시 굽는다 — 다른 페이지를 고치는 동안 이 페이지는 그대로 둔다 (레이어는 불변이라 얕게 견준다)
  const lastRef = useRef<{ layers: Layer[]; w: number; h: number; te: unknown; vis: boolean } | null>(null);
  useEffect(() => {
    if (!visible) {
      if (lastRef.current) lastRef.current.vis = false;
      return;
    }
    const prev = lastRef.current;
    const same = prev && prev.vis && prev.w === fitted.w && prev.h === fitted.h && prev.te === textEdit
      && prev.layers.length === doc.layers.length && prev.layers.every((l, i) => l === doc.layers[i]);
    if (same && !strokeRef.current) return;
    lastRef.current = { layers: doc.layers, w: fitted.w, h: fitted.h, te: textEdit, vis: true };
    paint();
  }, [doc.layers, fitted.w, fitted.h, textEdit, paint, visible]);
  useEffect(() => onFxReady(() => visible && paint()), [paint, visible]);

  /* ── 좌표 ── */
  const toDoc = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * doc.w, y: ((e.clientY - r.top) / r.height) * doc.h };
  };
  /** 으뜸(마지막에 고른 것) — 글자 도구가 본다. 손잡이는 **하나만 골랐을 때**(`single`)만 */
  const sel = doc.layers.find((l) => l.id === primaryOf(doc)) ?? null;
  const single = doc.sel.length === 1 ? sel : null;
  const editing = textEdit ? doc.layers.find((l) => l.id === textEdit.id && l.text) ?? null : null;
  const editingBubble = textEdit ? doc.layers.find((l) => l.id === textEdit.id && l.bubble) ?? null : null;
  const comic = doc.comic ?? null;
  /** 변형 손잡이가 붙는 것 — 컷(꼭짓점으로 고친다)·말풍선(몸통·꼬리 손잡이)은 뺀다 */
  const xformable = single && !single.panel && !single.bubble ? single : null;

  /** 손잡이 자리 (문서 좌표) — 네 모서리·네 변 가운데·회전 손잡이 */
  const handlesOf = (l: Layer) => {
    const c = centerOf(l);
    const r = rad(l.rot);
    const at = (lx: number, ly: number) => ({ x: c.x + lx * Math.cos(r) - ly * Math.sin(r), y: c.y + lx * Math.sin(r) + ly * Math.cos(r) });
    const hw = l.w / 2;
    const hh = l.h / 2;
    const list: { sx: -1 | 0 | 1; sy: -1 | 0 | 1; p: { x: number; y: number } }[] = [];
    for (const sy of [-1, 0, 1] as const) for (const sx of [-1, 0, 1] as const) {
      if (!sx && !sy) continue;
      list.push({ sx, sy, p: at(sx * hw, sy * hh) });
    }
    return { list, rot: at(0, -hh - 26 / scale), top: at(0, -hh) };
  };
  const hitHandle = (l: Layer, p: { x: number; y: number }) => {
    const h = handlesOf(l);
    const tol = 8 / scale;
    if (Math.hypot(h.rot.x - p.x, h.rot.y - p.y) <= tol) return { rotate: true as const };
    for (const x of h.list) if (Math.hypot(x.p.x - p.x, x.p.y - p.y) <= tol) return { handle: x };
    return null;
  };
  /** 그 자리의 맨 앞 레이어 (켜진 것만). ★판정은 화면에 보이는 **상자**다 — 픽셀로 보면 투명한 배경을 누를 때 선택이 풀려
   *  버린다 (사용자 지적 2026-09-22). `only` 로 종류를 거른다 */
  const topLayerAt = (p: { x: number; y: number }, only?: (l: Layer) => boolean) => {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.on && (!only || only(l)) && hitAt(l, p)) return l;
    }
    return null;
  };
  /** 누른 자리가 그 레이어인가 — 만화 캔버스는 셋이 다르다:
   *  컷은 **테두리 근처**만 (안쪽을 누르면 그 컷에 든 그림이 골라져야 한다) · 컷에 든 그림은 **컷 안**만 · 말풍선은 몸통과 꼬리 끝 */
  const hitAt = (l: Layer, p: { x: number; y: number }) => {
    if (l.panel) {
      const poly = panelPts(l, l.panel.pts);
      return pointInPoly(p, poly) && distToEdge(p, poly) <= Math.max(comic?.border ?? 4, 10 / scale);
    }
    if (l.bubble) {
      const b = l.bubble.body;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return true;
      return hasTails(l.bubble.kind) && l.bubble.tails.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= 12 / scale);
    }
    if (!hitLayer(l, p.x, p.y)) return false;
    const clip = clipOf(doc.layers, l);
    return !clip || pointInPoly(p, clip);
  };
  /** 그 자리의 맨 앞 컷 (안쪽 전체로 본다 — 컷 도구가 쓴다) */
  const panelAt = (p: { x: number; y: number }) => {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.on && l.panel && pointInPoly(p, panelPts(l, l.panel.pts))) return l;
    }
    return null;
  };
  /** 누른 자리의 인물 점 — 그 컷과 그 칸 (점 크기는 화면에서 늘 같다) */
  const castAt = (p: { x: number; y: number }) => {
    for (const l of doc.layers) {
      if (!l.panel || !l.on) continue;
      const b = bboxOf(panelPts(l, l.panel.pts));
      const hit = genOf(l.panel).cast.find((c) => Math.hypot(b.x + c.x * b.w - p.x, b.y + c.y * b.h - p.y) <= 12 / scale);
      if (hit) return { panel: l, key: hit.key };
    }
    return null;
  };
  /** 말풍선 손잡이 — 몸통 여덟 · 꼬리 끝(큰 것) · 휨(작은 것) (설계 6번 · 목업 ④) */
  const bubbleHandles = (l: Layer) => {
    const b = l.bubble!;
    const { x, y, w, h } = b.body;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const box8: { sx: -1 | 0 | 1; sy: -1 | 0 | 1; p: { x: number; y: number } }[] = [];
    for (const sy of [-1, 0, 1] as const) for (const sx of [-1, 0, 1] as const) {
      if (sx || sy) box8.push({ sx, sy, p: { x: cx + (sx * w) / 2, y: cy + (sy * h) / 2 } });
    }
    const tails = hasTails(b.kind)
      ? b.tails.map((q, i) => ({ i, tip: { x: q.x, y: q.y }, bend: bendable(b.kind) ? bendHandle(tailGeo(cx, cy, w / 2, h / 2, q)) : null }))
      : [];
    return { box8, tails, cx, cy };
  };
  const hitBubbleHandle = (l: Layer, p: { x: number; y: number }) => {
    const hb = bubbleHandles(l);
    for (const q of hb.tails) if (Math.hypot(q.tip.x - p.x, q.tip.y - p.y) <= 9 / scale) return { tip: q.i };
    for (const q of hb.tails) if (q.bend && Math.hypot(q.bend[0] - p.x, q.bend[1] - p.y) <= 7 / scale) return { bend: q.i };
    for (const q of hb.box8) if (Math.hypot(q.p.x - p.x, q.p.y - p.y) <= 8 / scale) return { box: q };
    return null;
  };
  /** 고른 말풍선의 손잡이를 눌렀나 — 눌렀으면 끌기를 시작하고 true. Alt 를 누르고 몸통을 누르면 **꼬리 하나 더** (두 사람이 같이 말할 때) */
  const bubbleDown = (e: React.PointerEvent, p: { x: number; y: number }, dbl: boolean): boolean => {
    const l = single?.bubble ? single : null;
    if (!l?.bubble) return false;
    const s = useEditor.getState();
    const h = hitBubbleHandle(l, p);
    if (h && "tip" in h) {
      // 끝점 더블클릭 = 그 꼬리 지우기
      if (dbl) {
        s.patchBubble(l.id, { tails: l.bubble.tails.filter((_, i) => i !== h.tip) });
        return true;
      }
      dragRef.current = { kind: "tip", start: p, layer: l, ti: h.tip };
    } else if (h && "bend" in h) {
      dragRef.current = { kind: "bend", start: p, layer: l, ti: h.bend };
    } else if (h && "box" in h) {
      dragRef.current = { kind: "body", start: p, layer: l, handle: h.box };
    } else if (e.altKey && hitAt(l, p) && hasTails(l.bubble.kind)) {
      s.markBefore();
      const tails = [...l.bubble.tails, { x: p.x, y: p.y, w: Math.max(8, l.bubble.size * 0.55), bend: 0 }];
      s.patchBubble(l.id, { tails }, true);
      dragRef.current = { kind: "tip", start: p, layer: useEditor.getState().layer() ?? l, ti: tails.length - 1, marked: true };
    } else return false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    return true;
  };

  /** 고른 레이어의 크기·회전 손잡이를 눌렀나 — 눌렀으면 끌기를 시작하고 true (선택 도구 · 효과음 도구) */
  const handleDown = (e: React.PointerEvent, p: { x: number; y: number }, l: Layer): boolean => {
    const h = hitHandle(l, p);
    if (h && "rotate" in h) {
      const c = centerOf(l);
      dragRef.current = { kind: "rotate", start: p, layer: l, rot0: l.rot, ang0: Math.atan2(p.y - c.y, p.x - c.x) };
    } else if (h && "handle" in h) {
      dragRef.current = { kind: "scale", start: p, layer: l, handle: h.handle };
    } else return false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    return true;
  };

  /* ── 누르기 ── */
  const down = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const p = toDoc(e);
    if (!p) return;
    // ★가운데 단추·이동 도구는 끌어 보기 — 넘칠 때만 끌 것이 있다 (무대가 받는다)
    if ((e.button === 1 || (tool === "pan" && e.button === 0)) && movable) {
      e.stopPropagation();
      onPanStart(e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (tool === "pan") return;
    // ★만화 캔버스 — 누른 페이지가 지금 페이지가 된다 (새 레이어가 여기 든다)
    if (pid) s.setPage(pid);

    // ── 인물 점 (선택·컷 도구) — 끌어서 그 컷 안의 자리를 정한다 (설계 8-3)
    if ((tool === "select" || tool === "panel") && comic) {
      const hit = castAt(p);
      if (hit) {
        s.setCut(hit.panel.id);
        dragRef.current = { kind: "cast", start: p, layer: hit.panel, key: hit.key };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
    }

    // ── 컷 도구: 고른 컷의 꼭짓점 → 꼭짓점 끌기 · 그 밖은 끌기 — 선이 컷을 지나면 자르기선(바깥에서 시작해도 된다),
    //    컷에 안 닿으면 새 컷 상자 (설계 5번 · 목업 ③). 컷 안을 짧게 누르면 그 컷을 고른다
    if (tool === "panel" && comic) {
      const selPanel = single?.panel ? single : null;
      if (selPanel?.panel) {
        const poly = panelPts(selPanel, selPanel.panel.pts);
        const vi = poly.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) <= 9 / scale);
        if (vi >= 0) {
          dragRef.current = { kind: "vertex", start: p, layer: selPanel, vi, poly0: poly };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          return;
        }
      }
      const inPanel = panelAt(p);
      dragRef.current = { kind: "cut", start: p, layer: inPanel ?? undefined };
      setCutLine({ ids: inPanel ? [inPanel.id] : [], a: p, b: p });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    // ── 말풍선 도구: 고른 말풍선의 손잡이 → 끌기 · 말풍선 → 고르고 옮기기(누르고 놓기만 하면 글 고치기) · 빈 자리 → 새 말풍선
    if (tool === "bubble" && comic) {
      const lastB = dblRef.current;
      const nowB = performance.now();
      dblRef.current = { t: nowB, x: e.clientX, y: e.clientY };
      const dblB = !!lastB && nowB - lastB.t < 400 && Math.hypot(e.clientX - lastB.x, e.clientY - lastB.y) < 6;
      if (bubbleDown(e, p, dblB)) return;
      const hitB = topLayerAt(p, (l) => !!l.bubble);
      if (hitB) {
        if (!doc.sel.includes(hitB.id)) s.selectLayer(hitB.id);
        dragRef.current = { kind: "move", start: p, layers: [hitB], tapEdit: true };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
      s.addBubble(p);
      return;
    }

    // ── 효과음 도구: 고른 효과음의 손잡이 → 크기·회전 · 효과음 → 고르고 옮기기 · 빈 자리 → 새 효과음 (설계 7번)
    if (tool === "sfx" && comic) {
      if (xformable?.sfx && handleDown(e, p, xformable)) return;
      const hitS = topLayerAt(p, (l) => !!l.sfx);
      if (hitS) {
        if (!doc.sel.includes(hitS.id)) s.selectLayer(hitS.id);
        dragRef.current = { kind: "move", start: p, layers: [hitS] };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
      s.addSfx(p);
      return;
    }

    if (tool === "crop") {
      dragRef.current = { kind: "crop", start: p };
      s.setCrop({ x: p.x, y: p.y, w: 0, h: 0 });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    if (tool === "text") {
      // 글자 레이어 위면 그것을 고친다 (고른 것 우선), 아니면 그 자리에 새 글자 레이어
      const hit = sel?.text && sel.on && hitLayer(sel, p.x, p.y) ? sel : topLayerAt(p, (l) => !!l.text);
      if (hit) {
        s.selectLayer(hit.id);
        s.beginTextEdit(hit.id);
      } else s.addText(p);
      return;
    }

    if (tool === "brush" || tool === "eraser" || tool === "bucket") {
      // ★고른 레이어가 **이 페이지의 것**이어야 한다 — 다른 페이지의 레이어에 이 페이지 좌표로 그리지 않는다
      let l = sel;
      if (!l) return toast(t("editor.noLayer"), "warn");
      // ★컷을 고른 채 그리면 그 컷의 「그리기」 레이어에 그린다 — 그 컷 그림 위, 컷 모양으로 잘린다 (사용자 결정 2026-09-28).
      //   처음 그을 때 생기고 골라진다. 지우개는 있는 것에서만 지운다 (컷 그림을 지우려면 그림 레이어를 고른다)
      if (l.panel) {
        const dl = s.panelDraw(l.id, tool !== "eraser");
        if (!dl) return toast(t("editor.panelNoDraw"), "warn");
        l = dl;
      }
      if (!l.on) return toast(t("editor.layerOff"), "warn");
      // ★글자·말풍선·효과음은 원문에서 굽는 레이어다 — 그 레이어에 그리려면 보통 그림으로 바꾼다 (사용자 결정 2026-09-28).
      //   바꾸면 글을 더 고칠 수 없으므로 묻는다. 바꾼 뒤 다시 그으면 그려진다 (포토샵의 래스터화와 같다)
      if (l.text || l.bubble || l.sfx) {
        const id = l.id;
        const what = l.bubble ? "editor.rasterBubble" : l.sfx ? "editor.rasterSfx" : "editor.rasterText";
        void ask({ title: t("editor.rasterTitle"), body: t(what), ok: t("editor.raster"), cancel: t("common.cancel") }).then((ok) => ok && s.rasterize(id));
        return;
      }
      // 페인트통 — 누른 자리와 이어진 같은 색을 채운다 (한 걸음)
      if (tool === "bucket") { s.fillAt(p); return; }
      const b = tool === "eraser" ? useUi.getState().editorBrush.eraser : useUi.getState().editorBrush.brush;
      const cv = makeCanvas(l.sw, l.sh);
      const st: Stroke = { cv, alpha: b.opacity / 100, erase: tool === "eraser" };
      strokeRef.current = { st, last: null, layer: l };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      strokeAt(p);
      return;
    }

    // 선택 도구 — 고른 레이어의 손잡이 → **누른 자리의 맨 앞 레이어**(상자 기준) → 아무 상자도 없으면 선택을 푼다
    // ★사용자 결정 2026-09-22: 앞의 레이어를 누르면 곧바로 그것이 골라진다 (한때 「고른 레이어 안이면 고른 것을 끈다」로
    //   두었다가 되돌렸다). 판정은 화면에 보이는 상자다 — 픽셀로 봤더니 투명한 배경을 누를 때 선택이 풀렸다.
    // ★같은 자리를 잇달아 두 번 누르면(더블클릭) 글자 레이어는 곧바로 글자 도구로 고친다 (사용자 지시 2026-09-22)
    // ★여럿 고르기 (사용자 지시 2026-09-22): Ctrl+클릭은 고른 것에 넣고 빼기, 빈 자리에서 끌면 끌어 고르기(상자가 통째로 든 것만),
    //   여럿을 고른 채 하나를 끌면 함께 옮긴다. 손잡이는 하나만 골랐을 때만 있다
    const last = dblRef.current;
    const now = performance.now();
    dblRef.current = { t: now, x: e.clientX, y: e.clientY };
    const dbl = !!last && now - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6;
    const multi = e.ctrlKey || e.metaKey;
    if (bubbleDown(e, p, dbl)) return;
    if (xformable && handleDown(e, p, xformable)) return;
    const hit = topLayerAt(p);
    if (dbl && hit?.text) {
      dblRef.current = null;
      s.setTool("text");
      s.selectLayer(hit.id);
      s.beginTextEdit(hit.id);
      return;
    }
    // 효과음을 더블클릭하면 효과음 도구로 바꾸고 기둥의 글 칸에 커서를 둔다
    if (dbl && hit?.sfx) {
      dblRef.current = null;
      s.setTool("sfx");
      s.selectLayer(hit.id);
      setTimeout(() => document.querySelector<HTMLInputElement>("[data-editor-sfx-text]")?.focus({ preventScroll: true }), 0);
      return;
    }
    // ★만화 캔버스 — 컷 안의 빈 자리(용지처럼 컷보다 아래 것)를 누르면 그 컷을 편다 (설계 8-1: 무대에서 컷을 눌러도 컷 번호를 누른 것과 같다).
    //   컷에 든 그림을 누른 것이면 아래의 selectLayer 가 그 컷을 편다
    if (comic && !multi) {
      const cut = panelAt(p);
      if (cut && (!hit || doc.layers.indexOf(hit) < doc.layers.indexOf(cut))) s.setCut(cut.id);
    }
    // 말풍선을 더블클릭하면 그 자리에서 글을 고친다 (글자 레이어와 같은 조작, 설계 6번)
    if (dbl && hit?.bubble) {
      dblRef.current = null;
      s.selectLayer(hit.id);
      s.beginTextEdit(hit.id);
      return;
    }
    if (hit) {
      if (multi) {
        s.toggleSelect(hit.id);
        if (doc.sel.includes(hit.id)) return;   // 뺐으면 끌 것이 없다
      } else if (!doc.sel.includes(hit.id)) s.selectLayer(hit.id);
      const ids = useEditor.getState().doc()?.sel ?? [hit.id];
      const group = doc.layers.filter((l) => ids.includes(l.id));
      dragRef.current = { kind: "move", start: p, layers: group.length ? group : [hit] };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    // 빈 자리 — 선택을 풀고(Ctrl 이면 둔다) 끌어 고르기를 시작한다
    if (!multi && doc.sel.length) s.selectLayer(null);
    dragRef.current = { kind: "marquee", start: p, base: multi ? doc.sel : [] };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  // ★캔버스 밖에서 시작하는 끌어 고르기 (보통 캔버스) — 무대가 부른다. 뒤의 움직임·놓기는 이 SVG 가 받는다
  if (outsideRef) {
    outsideRef.current = (e: React.PointerEvent) => {
      const p = toDoc(e);
      if (!p) return;
      const multi = e.ctrlKey || e.metaKey;
      dragRef.current = { kind: "marquee", start: p, base: multi ? doc.sel : [] };
      overlayRef.current?.setPointerCapture(e.pointerId);
    };
  }

  const strokeAt = (p: { x: number; y: number }) => {
    const sr = strokeRef.current;
    if (!sr) return;
    const ui = useUi.getState().editorBrush;
    const b = sr.st.erase ? ui.eraser : ui.brush;
    const l = sr.layer;
    const lp = docToLayer(l, p.x, p.y);
    const d = b.size * brushScale(l);
    const g = sr.st.cv.getContext("2d")!;
    strokeTo(g, sr.last, lp, d, b.hard, sr.st.erase ? "#ffffff" : ui.brush.color);
    sr.last = lp;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; paint(); });
  };

  const move = (e: React.PointerEvent) => {
    const p = toDoc(e);
    if (p) setCursor(p);
    const d = dragRef.current;
    const s = useEditor.getState();
    if (d) {
      if (!p) return;
      if (d.kind === "crop") {
        s.setCrop(normRect({ x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y }, doc));
        return;
      }
      if (d.kind === "cut") {
        // Shift 는 수평·수직 고정
        let b = p;
        if (e.shiftKey) b = Math.abs(p.x - d.start.x) >= Math.abs(p.y - d.start.y) ? { x: p.x, y: d.start.y } : { x: d.start.x, y: p.y };
        const ids = doc.layers.filter((l) => l.on && l.panel && segHitsPoly(d.start, b, panelPts(l, l.panel.pts))).map((l) => l.id);
        // 컷 밖에서 시작해 어느 컷에도 안 닿으면 새 컷 상자
        if (!d.layer && !ids.length) {
          setCutLine({ ids: [], a: d.start, b });
          setNewRect(rectFrom(d.start, p));
        } else {
          setNewRect(null);
          setCutLine({ ids, a: d.start, b });
        }
        return;
      }
      if (d.kind === "marquee") {
        // 끄는 동안 곧바로 골라진다 — 상자가 통째로 든 (켜진) 레이어. Ctrl 로 시작했으면 그때 골라 둔 것 위에 얹는다
        const r = rectFrom(d.start, p);
        setMarquee(r);
        const inside = doc.layers.filter((l) => l.on && boxInside(l, r)).map((l) => l.id);
        s.selectMany([...(d.base ?? []).filter((id) => !inside.includes(id)), ...inside]);
        return;
      }
      const l = d.layer!;
      // ★처음 움직이는 순간에 「끌기 전」을 적는다 — 그 뒤는 live 패치라 걸음이 하나다.
      //   말풍선 도구로 누른 말풍선은 끌기 시작하면 「놓으면 글 고치기」가 풀린다
      if (!d.marked) {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * scale < 2) return;
        s.markBefore();
        d.marked = true;
      }
      if (d.kind === "move") {
        // 고른 것 전부를 함께 — 각자 끌기 시작 때의 자리에서 같은 만큼 (말풍선은 꼬리 끝을 제자리에 둔다, `dragLayers`)
        s.dragLayers(d.layers ?? [], p.x - d.start.x, p.y - d.start.y);
        return;
      }
      if (d.kind === "cast" && d.key && l.panel) {
        // 컷 상자 안 비율로 — 생성 그림이 곧 컷 비율이라 그대로 NAI 좌표가 된다
        const b = bboxOf(panelPts(l, l.panel.pts));
        const x = Math.min(0.95, Math.max(0.05, (p.x - b.x) / Math.max(1, b.w)));
        const y = Math.min(0.95, Math.max(0.05, (p.y - b.y) / Math.max(1, b.h)));
        const cur = genOf(useEditor.getState().doc()?.layers.find((q) => q.id === l.id)?.panel ?? l.panel);
        s.setPanelGen(l.id, { cast: cur.cast.map((c) => (c.key === d.key ? { ...c, x, y } : c)) }, true);
        return;
      }
      if (d.kind === "vertex" && d.poly0 && d.vi !== undefined && l.panel && comic) {
        // 꼭짓점 — 이웃 컷의 변에서 간격만큼 떨어진 자리·기본 틀에 붙는다 (Alt 면 안 붙는다)
        const others = doc.layers.filter((x) => x.panel && x.id !== l.id).map((x) => panelPts(x, x.panel!.pts));
        const c = snapCands(others, comic);
        const tol = 8 / scale;
        const q: Pt = e.altKey ? [p.x, p.y] : [snapTo(p.x, c.xs, tol), snapTo(p.y, c.ys, tol)];
        s.setPanelPoly(l.id, d.poly0.map((v, i) => (i === d.vi ? q : v)), true);
        return;
      }
      if (d.kind === "tip" && d.ti !== undefined && l.bubble) {
        const cur = useEditor.getState().doc()?.layers.find((x) => x.id === l.id)?.bubble ?? l.bubble;
        s.patchBubble(l.id, { tails: cur.tails.map((q, i) => (i === d.ti ? { ...q, x: p.x, y: p.y } : q)) }, true);
        return;
      }
      if (d.kind === "bend" && d.ti !== undefined && l.bubble) {
        const cur = useEditor.getState().doc()?.layers.find((x) => x.id === l.id)?.bubble ?? l.bubble;
        const b0 = cur.body;
        const q0 = cur.tails[d.ti];
        const bend = bendFrom(b0.x + b0.w / 2, b0.y + b0.h / 2, b0.w / 2, b0.h / 2, q0, p);
        s.patchBubble(l.id, { tails: cur.tails.map((q, i) => (i === d.ti ? { ...q, bend } : q)) }, true);
        return;
      }
      if (d.kind === "body" && d.handle && l.bubble) {
        // 몸통 늘리기 — 반대편을 붙들고. 늘리면 「풍선에 맞춤」이 된다 (글이 몸통 폭에서 줄을 바꾼다)
        const b0 = l.bubble.body;
        const { sx, sy } = d.handle;
        const x0 = sx < 0 ? b0.x + b0.w : b0.x;
        const y0 = sy < 0 ? b0.y + b0.h : b0.y;
        const min = l.bubble.size * 1.5;
        const nx = sx ? Math.min(x0, p.x) : b0.x;
        const nw = sx ? Math.max(min, Math.abs(p.x - x0)) : b0.w;
        const ny = sy ? Math.min(y0, p.y) : b0.y;
        const nh = sy ? Math.max(min, Math.abs(p.y - y0)) : b0.h;
        s.patchBubble(l.id, { fit: "box", body: { x: sx < 0 ? x0 - nw : nx, y: sy < 0 ? y0 - nh : ny, w: nw, h: nh } }, true);
        return;
      }
      if (d.kind === "rotate") {
        const c = centerOf(l);
        let deg = (d.rot0 ?? 0) + ((Math.atan2(p.y - c.y, p.x - c.x) - (d.ang0 ?? 0)) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        s.patchLayer(l.id, { rot: ((deg % 360) + 360) % 360 }, true);
        return;
      }
      if (d.kind === "scale" && d.handle) {
        // 회전을 푼 자리에서 반대편 모서리를 붙들고 크기를 잰다
        const c = centerOf(l);
        const r = -rad(l.rot);
        const ux = (p.x - c.x) * Math.cos(r) - (p.y - c.y) * Math.sin(r);
        const uy = (p.x - c.x) * Math.sin(r) + (p.y - c.y) * Math.cos(r);
        const { sx, sy } = d.handle;
        const ox = -sx * (l.w / 2);
        const oy = -sy * (l.h / 2);
        let w = sx ? Math.max(1, Math.abs(ux - ox)) : l.w;
        let h = sy ? Math.max(1, Math.abs(uy - oy)) : l.h;
        // ★글자 레이어는 언제나 비율대로 — 상자를 늘리는 것이 곧 글꼴 크기라(놓을 때 `settleText` 가 다시 굽는다) 한쪽만 늘릴 수 없다
        if (l.text || l.sfx || (ratioLock && sx && sy)) {
          const kk = !sx ? h / l.h : !sy ? w / l.w : Math.max(w / l.w, h / l.h);
          w = l.w * kk;
          h = l.h * kk;
        }
        const ncx = sx ? ox + sx * (w / 2) : 0;
        const ncy = sy ? oy + sy * (h / 2) : 0;
        const rr = rad(l.rot);
        const cx = c.x + ncx * Math.cos(rr) - ncy * Math.sin(rr);
        const cy = c.y + ncx * Math.sin(rr) + ncy * Math.cos(rr);
        s.patchLayer(l.id, { x: cx - w / 2, y: cy - h / 2, w, h }, true);
      }
      return;
    }
    if (strokeRef.current && p) return strokeAt(p);
    if ((tool === "select" || tool === "bubble" || tool === "sfx" || tool === "panel") && p) {
      if (comic && (tool === "select" || tool === "panel") && castAt(p)) return setHoverCur("grab");
      if (tool === "panel") return setHoverCur(null);
      const bh = single?.bubble && tool !== "sfx" ? hitBubbleHandle(single, p) : null;
      if (bh) return setHoverCur(bh.box ? resizeCursor(0, bh.box) : "move");
      if (tool === "bubble") return setHoverCur(topLayerAt(p, (l) => !!l.bubble) ? "move" : null);
      if (tool === "sfx") {
        const hs = xformable?.sfx ? hitHandle(xformable, p) : null;
        return setHoverCur(hs ? ("rotate" in hs ? ROTATE_CURSOR : resizeCursor(xformable!.rot, hs.handle)) : topLayerAt(p, (l) => !!l.sfx) ? "move" : null);
      }
      const h = xformable ? hitHandle(xformable, p) : null;
      setHoverCur(h ? ("rotate" in h ? ROTATE_CURSOR : resizeCursor(xformable!.rot, h.handle)) : topLayerAt(p) ? "move" : null);
    }
  };

  const up = () => {
    const d = dragRef.current;
    if (d) {
      dragRef.current = null;
      if (d.kind === "crop") {
        const c = useEditor.getState().crop;
        if (c && (c.w < 2 || c.h < 2)) useEditor.getState().setCrop(null);
      }
      // 글자 레이어를 늘렸으면 — 늘린 만큼 글꼴 크기를 바꿔 다시 굽는다 (픽셀 확대를 남기지 않는다)
      if (d.kind === "scale" && d.marked && d.layer?.text) useEditor.getState().settleText(d.layer.id);
      if (d.kind === "scale" && d.marked && d.layer?.sfx) useEditor.getState().settleSfx(d.layer.id);
      if (d.kind === "marquee") setMarquee(null);
      const st = useEditor.getState();
      if (d.kind === "cut") {
        const line = cutLine;
        const r = newRect;
        setCutLine(null);
        setNewRect(null);
        const long = !!line && Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) * scale >= 12;
        // 끌었고 컷을 지나면 그 선으로 나눈다 · 컷에 안 닿은 상자면 새 컷 · 짧게 누르고 놓으면 그 컷을 고른다 (꼭짓점 손잡이가 뜬다)
        if (long && line!.ids.length) {
          if (!st.splitPanels(line!.ids, line!.a, line!.b)) toast(t("editor.cutMiss"), "warn");
        } else if (r && r.w * scale >= 12 && r.h * scale >= 12) st.addPanel(rectPts(r));
        else st.selectLayer(d.layer?.id ?? null);
      }
      // 말풍선 도구로 누르고 놓기만 했으면 글을 고친다
      if (d.kind === "move" && d.tapEdit && !d.marked && d.layers?.[0]) st.beginTextEdit(d.layers[0].id);
      return;
    }
    const sr = strokeRef.current;
    if (!sr) return;
    strokeRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    useEditor.getState().endStroke(sr.st);
  };

  const cursorStyle =
    tool === "pan" ? (movable ? "move" : "default")
      : tool === "crop" || tool === "bucket" ? "crosshair"
        : tool === "panel" ? hoverCur ?? "crosshair"
        : tool === "bubble" || tool === "sfx" ? hoverCur ?? "copy"
        : tool === "text" ? "text"
          : tool === "brush" || tool === "eraser" ? "none"
            : hoverCur ?? "default";

  const line = 1.5 / scale;
  const hs = 7 / scale;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        lineHeight: 0,
        userSelect: "none",
        boxShadow: "0 0 0 1px rgba(255,255,255,.06), 0 10px 40px rgba(0,0,0,.55)",
        // 캔버스의 투명한 자리 — 체커. 바깥 배경과 갈라 보이게 (사용자 지시 2026-09-22)
        background: "conic-gradient(#2a2a32 25%, #222229 0 50%, #2a2a32 0 75%, #222229 0) 0 0/16px 16px",
      }}
    >
      <canvas ref={canvasRef} data-editor-canvas data-page={pid ?? undefined} style={{ width: "100%", height: "100%", display: "block" }} />
      <svg
        ref={overlayRef}
        data-editor-overlay
        data-page={pid ?? undefined}
        viewBox={`0 0 ${doc.w} ${doc.h}`}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: cursorStyle, touchAction: "none", overflow: "visible" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => setCursor(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* 여럿을 골랐을 때 — 각 상자의 테두리만 (손잡이는 하나일 때만) */}
        {tool === "select" && doc.sel.length > 1 && !crop && (
          <g data-editor-multi>
            {doc.layers.filter((l) => doc.sel.includes(l.id)).map((l) => (
              <polygon key={l.id} points={cornersOf(l).map((c) => `${c.x},${c.y}`).join(" ")} fill="none" stroke="var(--accent-ink)" strokeWidth={line} />
            ))}
          </g>
        )}
        {/* 끌어 고르기 상자 */}
        {marquee && (marquee.w > 0 || marquee.h > 0) && (
          <rect data-editor-marquee x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(255,255,255,.06)" stroke="var(--accent-ink)" strokeWidth={line} strokeDasharray={`${4 / scale} ${3 / scale}`} />
        )}
        {/* 고른 레이어의 상자와 손잡이 — 선택 도구에서 하나만 골랐을 때 */}
        {(tool === "select" || (tool === "sfx" && !!xformable?.sfx)) && xformable && !crop && (() => {
          const cs = cornersOf(xformable);
          const h = handlesOf(xformable);
          return (
            <g data-editor-handles>
              <polygon points={cs.map((c) => `${c.x},${c.y}`).join(" ")} fill="none" stroke="var(--accent-ink)" strokeWidth={line} />
              <line x1={h.top.x} y1={h.top.y} x2={h.rot.x} y2={h.rot.y} stroke="var(--accent-ink)" strokeWidth={line} />
              <circle cx={h.rot.x} cy={h.rot.y} r={hs * 0.7} fill="var(--bg)" stroke="var(--accent-ink)" strokeWidth={line} />
              {h.list.map((x) => (
                <rect key={`${x.sx},${x.sy}`} x={x.p.x - hs / 2} y={x.p.y - hs / 2} width={hs} height={hs} rx={1.5 / scale} fill="var(--bg)" stroke="var(--accent-ink)" strokeWidth={line} />
              ))}
            </g>
          );
        })()}
        {/* ── 만화 캔버스 (화면에만 있다, 저장 그림에는 안 들어간다) ── */}
        {comic && <ComicOverlay doc={doc} scale={scale} tool={tool} single={single} cutLine={cutLine} newRect={newRect} bubbleHandles={bubbleHandles} editingId={editingBubble?.id ?? null} />}
        {/* 자르기 상자 — 바깥은 어둡게 */}
        {crop && crop.w > 0 && crop.h > 0 && (
          <g data-editor-crop>
            <path
              d={`M0 0H${doc.w}V${doc.h}H0Z M${crop.x} ${crop.y}H${crop.x + crop.w}V${crop.y + crop.h}H${crop.x}Z`}
              fill="rgba(0,0,0,.55)"
              fillRule="evenodd"
            />
            <rect x={crop.x} y={crop.y} width={crop.w} height={crop.h} fill="none" stroke="#fff" strokeWidth={line} strokeDasharray={`${6 / scale} ${4 / scale}`} />
          </g>
        )}
        {/* 붓 커서 */}
        {(tool === "brush" || tool === "eraser") && cursor && (
          <circle
            data-editor-brush
            cx={cursor.x}
            cy={cursor.y}
            r={brush.size / 2}
            fill={tool === "eraser" ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.08)"}
            stroke={tool === "eraser" ? "rgba(255,255,255,.85)" : brushes.brush.color}
            strokeWidth={line}
            style={{ pointerEvents: "none" }}
          />
        )}
      </svg>
      {/* 글 상자 — 글자 레이어를 고치는 동안 그 자리에 뜬다 (그 레이어는 합성에서 뺀다) */}
      {editing && textEdit && <TextEditBox key={editing.id} l={editing} scale={scale} value={textEdit.value} />}
      {editingBubble && textEdit && <BubbleEditBox key={editingBubble.id} l={editingBubble} scale={scale} value={textEdit.value} />}
    </div>
  );
}

/** 글자 레이어의 글 상자 — 레이어와 **같은 셈**(`textLayout`)으로 크기를 잡아 그 자리에 같은 글꼴로 뜬다.
 *  마무리는 세 갈래다: 밖을 누르거나(`blur`) Ctrl+Enter 면 반영, Esc 면 취소(방금 만든 것이면 레이어를 거둔다).
 *  ★치는 글은 스토어(`textEdit.value`)에 있고 마무리도 스토어(`endTextEdit`)가 한다 — 여기에는 상태도 정리 효과도 없다.
 *    언마운트에는 `onBlur` 이 안 오고(데스크 지침 「잊기 쉬운 것」), 정리 효과에 마무리를 걸면 개발 모드의 이중 마운트가
 *    뜨자마자 「빈 글 반영」을 돌려 방금 만든 레이어를 거둔다 (사용자 지적 2026-09-22: 눌러도 아무것도 안 생겼다). */
function TextEditBox({ l, scale, value }: { l: Layer; scale: number; value: string }) {
  const meta = l.text!;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  const L = textLayout({ ...meta, value });
  // 빈 글에도 커서가 들어갈 폭은 준다. 자리는 **닻**(정렬 쪽 위 모서리)을 레이어의 것에 맞춘다 — 상자가 레이어보다 넓거나 치는
  // 동안 넓어져도 글이 같은 자리에 있고, 돌려 둔 글자도 글자마다 밀리지 않는다 (사용자 지적 2026-09-22)
  const boxW = Math.max(L.w, meta.size * 2);
  const at = keepAnchor(l, { w: boxW, h: L.h }, meta.align);
  return (
    <textarea
      ref={ref}
      data-editor-text-input
      value={value}
      spellCheck={false}
      onChange={(e) => useEditor.getState().updateTextEdit(e.target.value)}
      onBlur={() => useEditor.getState().endTextEdit(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); useEditor.getState().endTextEdit(false); }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); useEditor.getState().endTextEdit(true); }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: at.x * scale,
        top: at.y * scale,
        width: boxW * scale,
        height: L.h * scale,
        // ★레이어의 변형(회전·반전)을 글 상자에도 건다 — 안 걸면 돌려 둔 글자가 고치는 동안 0° 로 보인다 (사용자 지적 2026-09-22)
        transform: `rotate(${l.rot}deg) scale(${l.flipH ? -1 : 1}, ${l.flipV ? -1 : 1})`,
        transformOrigin: "center",
        padding: L.pad * scale,
        boxSizing: "border-box",
        margin: 0,
        // ★테두리는 outline — border 는 1px 자리를 차지해 글이 구운 것보다 오른쪽 아래로 밀린다
        border: 0,
        outline: "1px dashed var(--accent-ink)",
        outlineOffset: -1,
        borderRadius: 2,
        background: "transparent",
        color: meta.color,
        font: fontOf({ ...meta, size: meta.size * scale }),
        lineHeight: `${L.lineH * scale}px`,
        textAlign: meta.align,
        whiteSpace: "pre",
        overflow: "hidden",
        resize: "none",
        caretColor: "var(--accent-ink)",
        userSelect: "text",
        zIndex: 2,
      }}
    />
  );
}

/** 만화 캔버스의 화면 표시 (한 페이지) — 안내선(기본 틀) · 컷 번호 · 고른 컷 · 생성할 컷 · 인물 점 · 대기/생성 중 · 자르기선 · 새 컷 상자 · 고른 말풍선의 손잡이.
 *  ★컷 번호는 만화 제작기 콘티와 같은 양식이다: 컷 왼쪽 위의 글자 번호, 고른 컷은 `#2f6fa8`.
 *    그림 위에 얹히므로 흰 테를 두른다. 크기는 화면에서 늘 같게 (`/ scale`) */
const SEL = "#2f6fa8";
/** Pretendard 숫자 높이 / 글자 크기 — 번호를 대문자 높이 기준으로 가운데에 앉힌다 (`CharPositioner` 의 `text-box: trim-both cap` 과 같은 자리) */
const CAP = 0.7;
let measure: CanvasRenderingContext2D | null = null;
const labelW = (s: string, size: number) => {
  measure ??= makeCanvas(1, 1).getContext("2d")!;
  measure.font = `600 ${size}px Pretendard, sans-serif`;
  return measure.measureText(s).width;
};
function ComicOverlay({
  doc, scale, tool, single, cutLine, newRect, bubbleHandles, editingId,
}: {
  doc: Doc;
  scale: number;
  tool: string;
  single: Layer | null;
  cutLine: { ids: string[]; a: { x: number; y: number }; b: { x: number; y: number } } | null;
  newRect: Rect | null;
  bubbleHandles: (l: Layer) => { box8: { sx: number; sy: number; p: { x: number; y: number } }[]; tails: { i: number; tip: { x: number; y: number }; bend: Pt | null }[] };
  editingId: string | null;
}) {
  const t = useI18n((st) => st.t);
  const page = doc.comic!;
  const k = 1 / scale;
  const nums = panelNumbers(doc.layers, page.dir, doc.h);
  const panels = doc.layers.filter((l) => l.panel && l.on);
  const selPanel = single?.panel ? single : null;
  // ★생성 버튼이 뽑을 컷 — 고른 것이 없어도 테두리로 남는다 (설계 8-1). 전체 문서에서 찾으므로 이 페이지 것일 때만 그린다
  const target = useEditor((s) => { const d = s.doc(); return d ? curCut(d)?.id ?? null : null; });
  const f = page.frame;
  // 자르기선이 만들 두 컷 (미리보기)
  const halves = cutLine && Math.hypot(cutLine.b.x - cutLine.a.x, cutLine.b.y - cutLine.a.y) * scale >= 12
    ? doc.layers
      .filter((l) => l.panel && cutLine.ids.includes(l.id))
      .flatMap((l) => splitPoly(panelPts(l, l.panel!.pts), cutLine.a, cutLine.b, gapFor(cutLine.a, cutLine.b, page.gapX, page.gapY)) ?? [])
    : null;
  const pts = (poly: Pt[]) => poly.map((q) => `${q[0]},${q[1]}`).join(" ");
  const bub = single?.bubble && (tool === "select" || tool === "bubble") && single.id !== editingId ? single : null;
  // ── 컷 생성: 인물 점 · 대기 · 생성 중 (설계 8번)
  const pending = useQueue((q) => q.pending);
  const steps = useQueue((q) => q.steps);
  useQueue((q) => q.progress);
  const ws = useWs((w) => w.current) ?? "";
  const group = comicGroupId(doc.id);
  const running = runningPendingId(group);
  // ★인물 점의 번호는 **페이지 흐름 순서**다 — 컷을 읽는 차례대로, 컷 안에서는 캐릭터 프롬프트 차례대로 이어 센다 (사용자 결정 2026-09-23)
  const flow = castNumbers(doc.layers, page.dir, doc.h);
  const chars = page.common.chars;
  type Mark = { key: string; n: number; x: number; y: number; color: string; name: string };
  const dots: Mark[] = panels.flatMap((l) => {
    const b = bboxOf(panelPts(l, l.panel!.pts));
    return genOf(l.panel).cast.map((c) => {
      const ci = chars.findIndex((x) => x.id === c.who);
      const neutral = c.who === WHO_NARRATION || c.who === WHO_BUBBLE;
      const name = c.who === WHO_NARRATION ? t("editor.narration") : c.who === WHO_BUBBLE ? t("editor.speechBubble") : ci >= 0 ? chars[ci].name || t("cards.charN", { n: ci + 1 }) : "?";
      return { key: `${l.id}:${c.key}`, n: flow.get(`${l.id}:${c.key}`) ?? 0, x: b.x + c.x * b.w, y: b.y + c.y * b.h, color: neutral || ci < 0 ? CAST_NEUTRAL : CAST_COLORS[ci % CAST_COLORS.length], name };
    });
  });
  const tp = target ? panels.find((l) => l.id === target) : undefined;
  return (
    <g data-editor-comic style={{ pointerEvents: "none" }}>
      {/* 대기 · 생성 중 — 그 컷 안에 (씬 칸의 대기 칸과 같은 말). 그리는 중인 그림이 오면 컷 모양으로 잘라 보여 준다 */}
      <defs>
        {panels.map((l) => <clipPath key={l.id} id={`cutclip-${l.id}`}><polygon points={pts(panelPts(l, l.panel!.pts))} /></clipPath>)}
      </defs>
      {panels.map((l) => {
        const mine = pending.filter((q) => q.groupId === group && q.cellId === l.id && q.workspace === ws);
        if (!mine.length) return null;
        const poly = panelPts(l, l.panel!.pts);
        const b = bboxOf(poly);
        const isRun = mine.some((q) => q.id === running);
        const step = steps[stepKey(ws, l.id)];
        return (
          <g key={`pend-${l.id}`} data-editor-cut-state={isRun ? "running" : "queued"} data-panel={l.id}>
            <polygon points={pts(poly)} fill={isRun ? "rgba(236,238,244,.72)" : "rgba(246,246,248,.6)"} />
            {isRun && step && <image href={step} x={b.x} y={b.y} width={b.w} height={b.h} preserveAspectRatio="xMidYMid slice" clipPath={`url(#cutclip-${l.id})`} opacity={0.85} />}
            <text x={b.x + b.w / 2} y={b.y + b.h / 2} textAnchor="middle" fontSize={13 * k} fontWeight={600} fill={isRun ? "#2f6fa8" : "#6a6a74"} stroke="#fff" strokeWidth={3 * k} paintOrder="stroke" style={{ fontFamily: "var(--font-sans)" }}>
              {isRun ? t("editor.cutRunning") : `${t("editor.cutQueued")}${mine.length > 1 ? ` · ${mine.length}` : ""}`}
            </text>
          </g>
        );
      })}
      {page.guides && (
        <rect data-editor-guides x={f.x} y={f.y} width={f.w} height={f.h} fill="none" stroke="#35a8d8" strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} opacity={0.75} />
      )}
      {/* 생성 버튼이 뽑을 컷 — 고른 컷이 아니어도 얇은 테두리로 남는다 */}
      {tp && tp.id !== selPanel?.id && (
        <polygon data-editor-panel-target points={pts(panelPts(tp, tp.panel!.pts))} fill="none" stroke={SEL} strokeWidth={1.5 * k} strokeDasharray={`${5 * k} ${3 * k}`} />
      )}
      {/* 고른 컷 — 선택 도구에서는 테두리만, 컷 도구에서는 꼭짓점 손잡이까지 */}
      {selPanel?.panel && (tool === "select" || tool === "panel") && (() => {
        const poly = panelPts(selPanel, selPanel.panel.pts);
        return (
          <g data-editor-panel-sel>
            <polygon points={pts(poly)} fill="rgba(47,111,168,.12)" stroke={SEL} strokeWidth={2 * k} />
            {tool === "panel" && poly.map(([x, y], i) => (
              <rect key={i} data-editor-vertex={i} x={x - 4 * k} y={y - 4 * k} width={8 * k} height={8 * k} rx={1.5 * k} fill="#fff" stroke={SEL} strokeWidth={1.5 * k} />
            ))}
          </g>
        );
      })()}
      {/* 컷 번호 — 읽는 차례 (컷 왼쪽 위) */}
      {panels.map((l) => {
        const poly = panelPts(l, l.panel!.pts);
        const tl = poly.reduce((a, q) => (q[0] + q[1] < a[0] + a[1] ? q : a));
        const on = selPanel?.id === l.id || target === l.id;
        return (
          <text
            key={l.id}
            data-editor-panel-no={nums.get(l.id)}
            x={tl[0] + 12 * k}
            y={tl[1] + 22 * k}
            fontSize={14 * k}
            fontWeight={600}
            fill={on ? SEL : "#526980"}
            stroke="#fff"
            strokeWidth={3 * k}
            paintOrder="stroke"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            {nums.get(l.id)}
          </text>
        );
      })}
      {/* 인물 점 — 번호 원 시안 D (사용자 결정 2026-09-28): 어두운 반투명 바탕 · 인물 색 테 · 흰 번호, 원 뒤에 이름표가 반쯤 깔린다.
          내레이션 · 말풍선은 무채색 테. 페이지 오른쪽 끝에 닿으면 이름표가 왼쪽으로 간다 (`CharPositioner` 의 `CharNo` 와 같은 생김새) */}
      {dots.map((c) => {
        const r = 10.5 * k;
        const lw = labelW(c.name, 10.5) * k + 25 * k;
        const left = c.x + lw > doc.w;
        const lx = left ? -lw : 0;
        return (
          <g key={c.key} data-editor-cast-dot={c.n} transform={`translate(${c.x},${c.y})`} style={{ filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.28))" }}>
            <rect x={lx} y={-8.5 * k} width={lw} height={17 * k} rx={5 * k} fill="rgba(30,30,36,.96)" stroke="#2e2e36" strokeWidth={k} />
            <text x={left ? -lw + 8 * k : 17 * k} y={(10.5 * CAP * k) / 2} fontSize={10.5 * k} fontWeight={600} fill="#ececf1" style={{ fontFamily: "var(--font-sans)" }}>{c.name}</text>
            <circle r={r} fill="rgba(14,14,18,.86)" />
            <circle r={r - k} fill="none" stroke={c.color} strokeWidth={2 * k} />
            <text textAnchor="middle" y={(11 * CAP * k) / 2} fontSize={11 * k} fontWeight={600} fill="#fff" style={{ fontFamily: "var(--font-sans)", fontVariantNumeric: "tabular-nums" }}>{c.n}</text>
          </g>
        );
      })}
      {/* 자르기선 (끄는 중) + 놓으면 생길 두 컷 */}
      {cutLine && cutLine.ids.length > 0 && (
        <g data-editor-cutline>
          {halves?.map((h, i) => <polygon key={i} points={pts(h)} fill="rgba(58,123,184,.10)" stroke="var(--accent-ink)" strokeWidth={1.2 * k} />)}
          <line x1={cutLine.a.x} y1={cutLine.a.y} x2={cutLine.b.x} y2={cutLine.b.y} stroke="#3a7bb8" strokeWidth={1.6 * k} strokeDasharray={`${6 * k} ${4 * k}`} />
          <circle cx={cutLine.b.x} cy={cutLine.b.y} r={4.5 * k} fill="#fff" stroke="#3a7bb8" strokeWidth={2 * k} />
        </g>
      )}
      {newRect && newRect.w > 0 && newRect.h > 0 && (
        <rect data-editor-newpanel x={newRect.x} y={newRect.y} width={newRect.w} height={newRect.h} fill="rgba(58,123,184,.10)" stroke="var(--accent-ink)" strokeWidth={1.2 * k} strokeDasharray={`${5 * k} ${3 * k}`} />
      )}
      {/* 고른 말풍선 — 몸통 상자 + 크기 손잡이 여덟 · 꼬리 끝(큰 손잡이) · 휨(작은 손잡이) */}
      {bub?.bubble && (() => {
        const hb = bubbleHandles(bub);
        const b = bub.bubble.body;
        return (
          <g data-editor-bubble-handles>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="#3a7bb8" strokeWidth={k} />
            {hb.box8.map((q) => (
              <rect key={`${q.sx},${q.sy}`} x={q.p.x - 3.5 * k} y={q.p.y - 3.5 * k} width={7 * k} height={7 * k} rx={1.2 * k} fill="#fff" stroke="#3a7bb8" strokeWidth={1.2 * k} />
            ))}
            {hb.tails.map((q) => (
              <g key={q.i}>
                {q.bend && <circle data-editor-tail-bend={q.i} cx={q.bend[0]} cy={q.bend[1]} r={3.6 * k} fill="#fff" stroke="#3a7bb8" strokeWidth={1.3 * k} />}
                <circle data-editor-tail-tip={q.i} cx={q.tip.x} cy={q.tip.y} r={6.5 * k} fill="#3a7bb8" stroke="#fff" strokeWidth={1.6 * k} />
              </g>
            ))}
          </g>
        );
      })()}
    </g>
  );
}

/** 말풍선의 글 상자 — 몸통 가운데에 같은 글꼴로 뜬다 (그동안 말풍선은 글을 뺀 채로 구워져 있다).
 *  마무리는 글자 레이어와 같다: 밖을 누르면(`blur`) · Ctrl+Enter 반영, Esc 취소. 치는 글은 스토어(`textEdit.value`)에 있다 */
function BubbleEditBox({ l, scale, value }: { l: Layer; scale: number; value: string }) {
  const b = l.bubble!;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const L = bubbleText({ ...b, value });
  const body = b.body;
  // 글 상자는 몸통 가운데의 글 크기 + 커서 여유
  const w = (b.vertical ? L.tw : L.tw + b.size) * scale;
  const h = (b.vertical ? L.th + b.size : L.th) * scale;
  const cx = (body.x + body.w / 2) * scale;
  const cy = (body.y + body.h / 2) * scale;
  return (
    <textarea
      ref={ref}
      data-editor-bubble-input
      value={value}
      spellCheck={false}
      onChange={(e) => useEditor.getState().updateTextEdit(e.target.value)}
      onBlur={() => useEditor.getState().endTextEdit(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); useEditor.getState().endTextEdit(false); }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); useEditor.getState().endTextEdit(true); }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: cx - w / 2,
        top: cy - h / 2,
        width: w,
        height: h,
        padding: 0,
        margin: 0,
        border: 0,
        outline: "1px dashed var(--accent-ink)",
        outlineOffset: 2,
        background: "transparent",
        color: b.color,
        font: fontOf({ ...b, size: b.size * scale }),
        lineHeight: `${L.lineH * scale}px`,
        textAlign: b.vertical ? "left" : b.align,
        writingMode: b.vertical ? "vertical-rl" : undefined,
        // 풍선에 맞춤이면 글이 몸통 폭에서 줄을 바꾼다 — 글 상자도 같게
        whiteSpace: b.fit === "box" ? "pre-wrap" : "pre",
        overflow: "hidden",
        resize: "none",
        caretColor: "var(--accent-ink)",
        userSelect: "text",
        zIndex: 2,
      }}
    />
  );
}
