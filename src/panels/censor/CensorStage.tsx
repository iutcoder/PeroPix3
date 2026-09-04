import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { coverOf, liveBoxes, useCensor, passes, type Box } from "../../store/censor";
import {
  HANDLES,
  cursorFor,
  ROTATE_GAP,
  anchorOf,
  angleTo,
  bigEnough,
  center,
  handlePoint,
  hitBox,
  hitHandle,
  resizeBox,
  type Handle,
  type Rect,
} from "../../lib/censorBox";

/** 무대. 그림 한 장과 그 위의 박스들 (v2 `censorPreviewCanvas` + `censorOverlayCanvas`).
 *
 *  세 겹이다 — 아래부터 **원본 `<img>` · 덮개 캔버스 · 손잡이 SVG**.
 *
 *  ★★덮개는 **여기서 그린다** (`CensorRenderer`). 서버에 물어보지 않으므로 박스를 끄는
 *    동안 기다릴 것이 없다. 캔버스에는 **덮개만** 그린다 (바탕은 투명) — 원본은 아래
 *    `<img>` 가 이미 깔고 있어서, 매 프레임 원본을 다시 그릴 이유가 없다.
 *  ★「들춰보기」는 그래서 **CSS 투명도 하나**로 끝난다. 다시 그리지 않는다.
 *  ★손잡이만 SVG 인 까닭: 돌아간 박스를 캔버스로 그리면 좌표 변환을 손으로 다 해야 하는데,
 *    SVG 는 `transform` 하나로 끝나고 히트 테스트도 우리 셈만 맞으면 된다.
 */
type Drag =
  | { kind: "draw"; x: number; y: number; x2: number; y2: number }
  | { kind: "move"; i: number; orig: Rect; sx: number; sy: number }
  | { kind: "resize"; i: number; orig: Rect; handle: Exclude<Handle, "rotate">; ax: number; ay: number }
  | { kind: "rotate"; i: number; cx: number; cy: number };

export function CensorStage() {
  const c = useCensor();
  const boxes = c.curBoxes();
  const im = c.cur();
  const size = im ? c.sizes[im.id] : undefined;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState(-1);
  const [scale, setScale] = useState(1);
  /** ★그림을 **판 안에 맞춘 화면 크기**(px). CSS 퍼센트로는 세로가 안 잡혀서 셈해서 못 박는다
   *  (사용자 지적 2026-09-04: *"검열중 화면이 앱 안에 꽉차게 표시되어야 하는데 원본 해상도로
   *  표시되어서 전체화면으로만 작업할 수 있음"*). 세로로 긴 그림은 `max-height: 100%` 가
   *  **부모 높이가 auto 라 안 먹었다** — 그래서 원본 크기 그대로 서고 판을 넘쳤다. */
  const [fitted, setFitted] = useState<{ w: number; h: number } | null>(null);
  const editable = c.tab !== "before";

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** 덮개를 **지금 당장** 다시 그린다.
   *
   *  ★★값을 `getState()` 로 읽는다. 끄는 동안 리액트가 다시 그려 주기를 기다리지 않고
   *    이 함수를 그 자리에서 부르기 때문이다 (한 프레임도 늦지 않는다).
   *  ★캔버스 버퍼는 **화면에 보이는 크기 × 화면 배율**이다. 원본 크기로 그리면 큰 그림에서
   *    쓸데없이 몇 배를 칠하게 되고, 눈에 보이는 것은 똑같다. */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const el = imgRef.current;
    if (!cv || !el) return;
    const st = useCensor.getState();
    const cur = st.cur();
    const r = st.renderer;
    const sz = cur ? st.sizes[cur.id] : undefined;
    const g = cv.getContext("2d");
    if (!r || !cur || !sz || st.tab === "before") {
      if (g) g.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const shown = el.clientWidth;
    if (!shown) return;
    /* ★끄는 동안에는 **낮은 해상도로** 굽는다 (`censorRender` 의 `STEAM_WORK_QUICK`).
       스팀은 모양이 바뀔 때마다 다시 만들어야 해서, 제 해상도로 태우면 손이 걸린다.
       손을 떼면 `editing` 이 꺼지고 이 함수가 한 번 더 돌아 제 해상도로 다시 굽는다. */
    r.draw(cv, liveBoxes(st.boxes[cur.id] ?? []), coverOf(st), (shown * dpr) / sz.w, false, st.editing);
  }, []);

  /** 그림 좌표 ↔ 화면 좌표의 배율 + **판에 맞춘 크기**.
   *
   *  ★재는 대상은 **판**(무대를 감싼 칸)이다. 그림 자신을 재면 「지금 크기」를 되먹여
   *    줄어들 줄을 모른다 (커지기만 하고 다시 못 줄어드는 되먹임이 된다).
   *  ★확대는 안 한다 — 작은 그림을 억지로 늘리면 뭉개진다. 줄이기만 한다. */
  useEffect(() => {
    const el = wrapRef.current;
    const host = el?.parentElement;
    if (!el || !host || !size) return;
    const fit = () => {
      const bw = host.clientWidth, bh = host.clientHeight;
      if (!bw || !bh) return;
      const k = Math.min(bw / size.w, bh / size.h, 1);
      const w = Math.max(1, Math.floor(size.w * k));
      const h = Math.max(1, Math.floor(size.h * k));
      setFitted((old) => (old && old.w === w && old.h === h ? old : { w, h }));
      setScale(w / size.w || 1);
      paint();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    fit();
    return () => ro.disconnect();
  }, [size?.w, size?.h, c.src, paint]);

  // ★박스·설정이 바뀌면 `rev` 가 오르고, 여기서 다시 그린다 (끄는 동안에는 `move` 가 직접 부른다)
  useEffect(() => {
    paint();
    // ★`editing` 도 딸림값이다 — 손을 뗀 순간 **제 해상도로 다시 굽기** 위해서다.
    //   박스를 안 옮긴 채 눌렀다 떼도(고르기만) 낮은 해상도가 남지 않는다.
  }, [c.rev, c.src, c.tab, c.renderer, c.editing, paint]);

  const toImage = (e: React.PointerEvent) => {
    const el = imgRef.current;
    if (!el || !size) return null;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h };
  };

  /** 손잡이가 보이는 박스. 고른 것과 가리킨 것 (v2 와 같다) */
  const visible = [c.sel, hover].filter((i) => i >= 0);
  const tol = 12 / Math.max(scale, 0.01);

  const down = (e: React.PointerEvent) => {
    const p = toImage(e);
    if (!p) return;
    if (!editable) {
      // 검열 전 탭은 **읽기 전용**이다. 박스를 눌러 끄고 켜는 것만 한다 (v2 도 같다)
      const i = hitBox(boxes, p.x, p.y);
      if (i >= 0) c.toggleBox(i);
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (c.tool === "delete") {
      const i = hitBox(boxes, p.x, p.y);
      if (i >= 0) c.removeBox(i);
      return;
    }
    const h = hitHandle(boxes, p.x, p.y, tol, visible);
    if (h.handle === "rotate") {
      const ct = center(boxes[h.index].box);
      c.set({ sel: h.index, editing: true });
      return setDrag({ kind: "rotate", i: h.index, cx: ct.x, cy: ct.y });
    }
    if (h.handle) {
      const b = boxes[h.index];
      const a = anchorOf(b.box, b.rotation ?? 0, h.handle);
      c.set({ sel: h.index, editing: true });
      return setDrag({ kind: "resize", i: h.index, orig: [...b.box], handle: h.handle, ax: a.x, ay: a.y });
    }
    const i = c.tool === "select" ? hitBox(boxes, p.x, p.y) : -1;
    if (i >= 0) {
      c.set({ sel: i, editing: true });
      return setDrag({ kind: "move", i, orig: [...boxes[i].box], sx: p.x, sy: p.y });
    }
    // 빈 곳. 추가 도구면 새 박스를 그린다
    c.set({ sel: -1 });
    if (c.tool === "add") setDrag({ kind: "draw", x: p.x, y: p.y, x2: p.x, y2: p.y });
  };

  const move = (e: React.PointerEvent) => {
    const p = toImage(e);
    if (!p) return;
    if (!drag) {
      if (!editable) return;
      const h = hitHandle(boxes, p.x, p.y, tol, visible);
      setHover(h.index >= 0 ? h.index : hitBox(boxes, p.x, p.y));
      return;
    }
    if (drag.kind === "draw") return setDrag({ ...drag, x2: p.x, y2: p.y });
    const list = [...boxes];
    if (drag.kind === "move") {
      const [a, b, x, y] = drag.orig;
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      list[drag.i] = { ...list[drag.i], box: [a + dx, b + dy, x + dx, y + dy] };
    } else if (drag.kind === "resize") {
      list[drag.i] = {
        ...list[drag.i],
        box: resizeBox(drag.orig, list[drag.i].rotation ?? 0, drag.handle, { x: drag.ax, y: drag.ay }, p.x, p.y, e.ctrlKey),
      };
    } else {
      list[drag.i] = { ...list[drag.i], rotation: angleTo(drag.cx, drag.cy, p.x, p.y) };
    }
    // ★가진 것은 `getState()` 로 읽는다. 한 프레임에 pointermove 가 여러 번 오면
    //   렌더 때 찍힌 값은 옛것이라, 다른 그림의 박스가 되살아날 수 있다
    const s = useCensor.getState();
    const cur = s.cur();
    if (!cur) return;
    s.set({ boxes: { ...s.boxes, [cur.id]: list } });
    /* ★★**그 자리에서 다시 그린다.** 리액트가 다시 그려 주기를 기다리지 않는다 —
       `paint` 는 스토어를 `getState()` 로 읽으므로 방금 넣은 값이 바로 반영된다.
       서버 왕복이 없으므로 프레임마다 불러도 손이 안 걸린다. */
    paint();
  };

  const up = () => {
    if (!drag) return;
    if (drag.kind === "draw") {
      const r: Rect = [
        Math.min(drag.x, drag.x2),
        Math.min(drag.y, drag.y2),
        Math.max(drag.x, drag.x2),
        Math.max(drag.y, drag.y2),
      ];
      if (bigEnough(r)) c.addBox(r.map(Math.round) as Rect);
      else c.set({ editing: false });
    } else {
      c.putBoxes(boxes);
    }
    // ★손을 떼면 덮개를 다시 진하게 (「들춰보기」는 끄는 동안만이다)
    c.set({ editing: false });
    setDrag(null);
  };

  const cursor =
    !editable ? "default"
    : c.tool === "delete" ? (hover >= 0 ? "pointer" : "not-allowed")
    : drag?.kind === "rotate" ? "grabbing"
    : c.tool === "add" ? "crosshair"
    : hover >= 0 ? "move"
    : "default";

  if (!im) return null;

  // ★가린 뒤에는 테두리를 늘 그리지 않는다 (아래 `BoxShape` 의 ★주). 가릴 것이 있으면 참
  const covered = editable && boxes.some((b) => !b.off);

  const shown = boxes
    .map((b, i) => ({ b, i }))
    // ★낮은 신뢰도 숨김은 **보이는 것만** 거른다 (v2 주석 그대로: 실제 검열엔 영향 없음)
    .filter(({ b }) => c.tab !== "before" || b.manual || b.confidence >= c.floor);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        lineHeight: 0,
        // ★셈한 크기로 못 박는다 (아직 못 쟀으면 판 안으로만 묶어 둔다)
        width: fitted ? fitted.w : undefined,
        height: fitted ? fitted.h : undefined,
        maxWidth: "100%",
        maxHeight: "100%",
      }}
    >
      <img
        ref={imgRef}
        data-censor-img
        src={c.src ?? undefined}
        alt=""
        draggable={false}
        onLoad={(e) => {
          const el = e.currentTarget;
          if (!size) c.set({ sizes: { ...c.sizes, [im.id]: { w: el.naturalWidth, h: el.naturalHeight } } });
          setScale(el.clientWidth / (size?.w ?? el.naturalWidth) || 1);
        }}
        // ★칸을 꽉 채운다 — 칸의 크기는 위에서 그림 비율대로 셈해 두었다
        style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none", display: "block" }}
      />
      <canvas
        ref={canvasRef}
        data-censor-cover
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          // ★손잡이를 잡고 있는 동안 옅게 — **방식을 가리지 않는 공통 동작**이다 (v2 「조작시 투명도」)
          //   ★다시 그리지 않는다. 캔버스 한 장의 투명도만 바뀐다
          opacity: c.editing ? 1 - c.peek / 100 : 1,
        }}
      />
      <svg
        data-censor-overlay
        viewBox={size ? `0 0 ${size.w} ${size.h}` : undefined}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor, touchAction: "none" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => {
          // ★우클릭 = 삭제 (v2 와 같다). 도구를 바꾸지 않고도 하나를 뺄 수 있어야 한다
          e.preventDefault();
          if (!editable) return;
          const el = imgRef.current;
          if (!el || !size) return;
          const r = el.getBoundingClientRect();
          const i = hitBox(boxes, ((e.clientX - r.left) / r.width) * size.w, ((e.clientY - r.top) / r.height) * size.h);
          if (i >= 0) c.removeBox(i);
        }}
      >
        {shown.map(({ b, i }) => (
          <BoxShape
            key={i}
            b={b}
            i={i}
            sel={c.sel === i}
            hot={hover === i}
            del={editable && c.tool === "delete"}
            ok={passes(b, c.labelConf, c.conf)}
            editable={editable}
            scale={scale}
            covered={covered}
          />
        ))}
        {drag?.kind === "draw" && (
          <rect
            x={Math.min(drag.x, drag.x2)}
            y={Math.min(drag.y, drag.y2)}
            width={Math.abs(drag.x2 - drag.x)}
            height={Math.abs(drag.y2 - drag.y)}
            fill="rgba(90,140,255,0.2)"
            stroke="var(--accent)"
            strokeWidth={1.5 / scale}
          />
        )}
      </svg>
    </div>
  );
}

/** 박스 하나를 그린다. 테두리 · 라벨 · 손잡이 아홉.
 *
 *  ★가린 뒤에는 **테두리를 가리킬 때만** 그린다 (v2 와 같다). 늘 그리면 결과가 어떻게
 *    보일지 알 수 없다. 검열 중 탭에서 보는 것은 「가려진 그림」이지 「박스 목록」이 아니다. */
function BoxShape({
  b, i, sel, hot, del, ok, editable, scale, covered,
}: {
  b: Box;
  i: number;
  sel: boolean;
  hot: boolean;
  del: boolean;
  ok: boolean;
  editable: boolean;
  scale: number;
  covered: boolean;
}) {
  const t = useI18n((s) => s.t);
  const [x1, y1, x2, y2] = b.box;
  const ct = center(b.box);
  const rot = b.rotation ? `rotate(${(b.rotation * 180) / Math.PI} ${ct.x} ${ct.y})` : undefined;
  const line = 1.5 / scale;
  const show = !editable || !covered || sel || hot;
  const stroke = del && hot ? "#ff5050" : sel ? "#00c8ff" : b.off ? "var(--ink-ghost)" : ok ? "#dc3c3c" : "#808080";

  return (
    <g transform={rot} opacity={b.off ? 0.45 : 1}>
      <rect
        data-censor-box={i}
        x={x1}
        y={y1}
        width={x2 - x1}
        height={y2 - y1}
        fill={del && hot ? "rgba(255,80,80,0.3)" : show && !covered ? "rgba(220,60,60,0.12)" : "transparent"}
        stroke={show ? stroke : "transparent"}
        strokeWidth={line * (sel ? 1.6 : 1)}
        strokeDasharray={b.off ? `${6 / scale} ${4 / scale}` : undefined}
      />
      {show && !covered && (
        <text
          x={x1 + 4 / scale}
          y={y1 - 5 / scale}
          fill={stroke}
          fontSize={12 / scale}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {b.manual ? t("censor.manualBox") : `${b.label} ${b.confidence}`}
        </text>
      )}
      {editable && (sel || hot) && !del && (
        <>
          <line x1={ct.x} y1={y1} x2={ct.x} y2={y1 - ROTATE_GAP + 6} stroke={stroke} strokeWidth={line} />
          <circle cx={ct.x} cy={y1 - ROTATE_GAP} r={6 / scale} fill={stroke} />
          {HANDLES.map((h) => {
            const p = handlePoint(b.box, h);
            const s = (h.length === 2 ? 8 : 6) / scale;
            return (
              <rect key={h} x={p.x - s / 2} y={p.y - s / 2} width={s} height={s} fill={stroke}
                // ★커서는 **돌아간 방향**으로 고른다 (`cursorFor` 의 ★★주)
                style={{ cursor: cursorFor(h, b.rotation ?? 0) }} />
            );
          })}
        </>
      )}
    </g>
  );
}
