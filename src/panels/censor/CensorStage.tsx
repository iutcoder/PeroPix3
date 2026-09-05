import { useCallback, useEffect, useRef, useState } from "react";
import { coverOf, useCensor, passes, type Box } from "../../store/censor";
import { GRID, cellAt, outlinePath, toRenderBoxes } from "../../lib/censorMask";
import { hitBox } from "../../lib/censorBox";

/** 무대. 그림 한 장과 그 위의 덮개 (v2 `censorPreviewCanvas` + `censorOverlayCanvas`).
 *
 *  세 겹이다 — 아래부터 **원본 `<img>` · 덮개 캔버스 · 조작 SVG**.
 *
 *  ★★덮개는 **여기서 그린다** (`CensorRenderer`). 서버에 물어보지 않으므로 붓을 끄는
 *    동안 기다릴 것이 없다. 캔버스에는 **덮개만** 그린다 (바탕은 투명) — 원본은 아래
 *    `<img>` 가 이미 깔고 있어서, 매 프레임 원본을 다시 그릴 이유가 없다.
 *  ★「들춰보기」는 그래서 **CSS 투명도 하나**로 끝난다. 다시 그리지 않는다.
 *
 *  ★★검열 중·후 탭의 조작은 **붓과 지우개**다 (사용자 지시 2026-09-05: *"인페인트 브러시처럼
 *    사각형 브러시로 칠하고 지우는 형태로. YOLO 박스도 마찬가지로 지우기 가능하게"*).
 *    박스를 고르고·옮기고·늘리고·돌리던 손잡이는 걷었다 — 찾은 박스는 검열 중으로 넘어갈 때
 *    격자에 구워지므로(`scanAll`), 여기서는 찾은 것과 칠한 것을 가르지 않는다.
 *  ★검열 전 탭은 그대로 **읽기 전용 박스 목록**이다 — 눌러서 끄고 켠다.
 */
export function CensorStage() {
  const c = useCensor();
  const boxes = c.curBoxes();
  const im = c.cur();
  const size = im ? c.sizes[im.id] : undefined;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [hover, setHover] = useState(-1);
  const [scale, setScale] = useState(1);
  /** ★그림을 **판 안에 맞춘 화면 크기**(px). CSS 퍼센트로는 세로가 안 잡혀서 셈해서 못 박는다
   *  (사용자 지적 2026-09-04: *"검열중 화면이 앱 안에 꽉차게 표시되어야 하는데 원본 해상도로
   *  표시되어서 전체화면으로만 작업할 수 있음"*). 세로로 긴 그림은 `max-height: 100%` 가
   *  **부모 높이가 auto 라 안 먹었다** — 그래서 원본 크기 그대로 서고 판을 넘쳤다. */
  const [fitted, setFitted] = useState<{ w: number; h: number } | null>(null);
  const editable = c.tab !== "before";
  /** 붓이 닿을 자리 (그림 좌표의 칸). 손을 대고 있을 때만 그린다 */
  const [cursorCell, setCursorCell] = useState<{ gx: number; gy: number } | null>(null);
  /** 긋는 중 — 지난 칸과 지우개 여부. ★ref 다: pointermove 는 리액트 렌더를 안 기다린다 */
  const strokeRef = useRef<{ last: { gx: number; gy: number } | null; erase: boolean } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 긋는 동안 보이는 칠한 칸의 윤곽 (`outlinePath`). ★ref 로 `d` 를 바로 쓴다 — 긋는 중엔 리액트가 안 돈다 */
  const outlineRef = useRef<SVGPathElement | null>(null);

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
    /* ★★긋는 동안만 **칠한 칸의 윤곽**을 얹는다 (사용자 지시 2026-09-05: *"그리는 중에는 박스
       경계선이 보이게 — 어떻게 칠해서 연결되고 있는지 확인할 수 있게"*). 구름은 이어진 칸을
       한 덩이로 뭉개므로, 어디가 붙었고 어디가 떨어졌는지는 이 선이 말해 준다. */
    outlineRef.current?.setAttribute("d", st.editing && st.paint[cur.id] ? outlinePath(st.paint[cur.id]) : "");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const shown = el.clientWidth;
    if (!shown) return;
    /* ★끄는 동안에는 **낮은 해상도로** 굽는다 (`censorRender` 의 `STEAM_WORK_QUICK`).
       스팀은 모양이 바뀔 때마다 다시 만들어야 해서, 제 해상도로 태우면 손이 걸린다.
       손을 떼면 `editing` 이 꺼지고 이 함수가 한 번 더 돌아 제 해상도로 다시 굽는다. */
    r.draw(cv, toRenderBoxes(st.paint[cur.id]), coverOf(st), (shown * dpr) / sz.w, false, st.editing);
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

  // ★칸·설정이 바뀌면 `rev` 가 오르고, 여기서 다시 그린다 (끄는 동안에는 `move` 가 직접 부른다)
  useEffect(() => {
    paint();
    // ★`editing` 도 딸림값이다 — 손을 뗀 순간 **제 해상도로 다시 굽기** 위해서다.
  }, [c.rev, c.src, c.tab, c.renderer, c.editing, paint]);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el || !size) return null;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h };
  };

  const cellOf = (e: { clientX: number; clientY: number }) => {
    const p = toImage(e);
    const g = useCensor.getState().curGrid();
    return p && g ? cellAt(g, p.x, p.y) : null;
  };

  const down = (e: React.PointerEvent) => {
    const p = toImage(e);
    if (!p) return;
    if (!editable) {
      // 검열 전 탭은 **읽기 전용**이다. 박스를 눌러 끄고 켜는 것만 한다 (v2 도 같다)
      const i = hitBox(boxes, p.x, p.y);
      if (i >= 0) c.toggleBox(i);
      return;
    }
    const cell = cellOf(e);
    if (!cell) return;
    const st = useCensor.getState();
    /* ★★오른쪽 단추는 **이어진 덩어리 삭제**다 (사용자 지시 2026-09-05: *"우클릭을 기존처럼 박스
       전체삭제로. 연결되어 있는 것 기준으로 모두 지움"*). 박스 시절의 우클릭 삭제 자리 —
       붓에서 「박스」에 해당하는 것이 이어진 덩어리다. 끌지 않는다 (한 번 눌러 한 덩어리). */
    if (e.button === 2) {
      st.eraseBlob(cell);
      paint();
      return;
    }
    if (e.button !== 0) return;
    const erase = c.tool === "erase";
    if (!st.strokeBegin()) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    strokeRef.current = { last: cell, erase };
    st.strokeAt(cell, null, erase);
    paint();
  };

  const move = (e: React.PointerEvent) => {
    if (!editable) {
      const p = toImage(e);
      if (p) setHover(hitBox(boxes, p.x, p.y));
      return;
    }
    const cell = cellOf(e);
    setCursorCell(cell);
    const s = strokeRef.current;
    if (!s || !cell) return;
    if (s.last && s.last.gx === cell.gx && s.last.gy === cell.gy) return;
    /* ★★**그 자리에서 다시 그린다.** 리액트가 다시 그려 주기를 기다리지 않는다 —
       칸은 제자리에서 바뀌었고 `paint` 는 스토어를 `getState()` 로 읽으므로 바로 반영된다.
       서버 왕복이 없으므로 프레임마다 불러도 손이 안 걸린다. */
    useCensor.getState().strokeAt(cell, s.last, s.erase);
    s.last = cell;
    paint();
  };

  const up = () => {
    if (!strokeRef.current) return;
    strokeRef.current = null;
    // ★손을 떼면 덮개를 다시 진하게 (「들춰보기」는 끄는 동안만이다) — 그리고 제 해상도로 다시 굽는다
    useCensor.getState().strokeEnd();
  };

  const cursor = !editable ? (hover >= 0 ? "pointer" : "default") : "none";

  if (!im) return null;

  const shown = boxes
    .map((b, i) => ({ b, i }))
    // ★낮은 신뢰도 숨김은 **보이는 것만** 거른다 (v2 주석 그대로: 실제 검열엔 영향 없음)
    .filter(({ b }) => b.manual || b.confidence >= c.floor);

  // 붓 미리보기 — **눌렀을 때 칠해질 칸**을 그대로 그린다 (`stamp` 와 같은 식: 변은 2r+1)
  const side = (c.brush * 2 + 1) * GRID;
  const erasing = c.tool === "erase" || strokeRef.current?.erase;

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
          // ★붓을 끄는 동안 옅게 — **방식을 가리지 않는 공통 동작**이다 (v2 「조작시 투명도」)
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
        onPointerLeave={() => setCursorCell(null)}
        // ★우클릭 메뉴를 막는다 — 오른쪽 단추는 이어진 덩어리 삭제다
        onContextMenu={(e) => e.preventDefault()}
      >
        {editable && (
          <path
            ref={outlineRef}
            data-censor-outline
            fill="none"
            stroke="rgba(255,64,96,0.95)"
            strokeWidth={1.5 / scale}
            style={{ pointerEvents: "none" }}
          />
        )}
        {!editable && shown.map(({ b, i }) => (
          <BoxShape key={i} b={b} hot={hover === i} ok={passes(b, c.labelConf, c.conf)} scale={scale} />
        ))}
        {editable && cursorCell && (
          <rect
            data-censor-brush
            x={(cursorCell.gx - c.brush) * GRID}
            y={(cursorCell.gy - c.brush) * GRID}
            width={side}
            height={side}
            fill={erasing ? "rgba(255,255,255,0.14)" : "rgba(255,64,96,0.22)"}
            stroke={erasing ? "rgba(255,255,255,0.85)" : "rgba(255,64,96,0.9)"}
            strokeWidth={1.5 / scale}
            style={{ pointerEvents: "none" }}
          />
        )}
      </svg>
    </div>
  );
}

/** 검열 전 탭의 박스 하나 — 테두리와 이름. 눌러서 끄고 켠다 (손잡이는 없다) */
function BoxShape({ b, hot, ok, scale }: { b: Box; hot: boolean; ok: boolean; scale: number }) {
  const [x1, y1, x2, y2] = b.box;
  const line = 1.5 / scale;
  const stroke = b.off ? "var(--ink-ghost)" : ok ? "#dc3c3c" : "#808080";

  return (
    <g opacity={b.off ? 0.45 : 1}>
      <rect
        x={x1}
        y={y1}
        width={x2 - x1}
        height={y2 - y1}
        fill={hot ? "rgba(220,60,60,0.2)" : "rgba(220,60,60,0.12)"}
        stroke={stroke}
        strokeWidth={line * (hot ? 1.6 : 1)}
        strokeDasharray={b.off ? `${6 / scale} ${4 / scale}` : undefined}
      />
      <text
        x={x1 + 4 / scale}
        y={y1 - 5 / scale}
        fill={stroke}
        fontSize={12 / scale}
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {`${b.label} ${b.confidence}`}
      </text>
    </g>
  );
}
