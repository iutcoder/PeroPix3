/** 검열 자리 — **칠한 칸의 격자**. 순수 계산만 둔다 (캔버스·DOM 없음).
 *
 *  ★★사용자 지시 2026-09-05: *"인페인트 브러시처럼 사각형 브러시로 칠하고 지우는 형태로.
 *    YOLO 모델이 만들어 준 박스도 마찬가지로 지우기 가능하게"*. 그래서 검열 중·후 탭의
 *    편집 대상은 박스 목록이 아니라 **이 격자 하나**다 — 찾은 박스는 여기에 구워 넣고,
 *    그 뒤로는 사람이 칠한 것과 구별하지 않는다. 지우개는 어느 쪽이든 똑같이 지운다.
 *  ★인페인트 마스크(`MaskEditor`)와 같은 **8px 격자·사각 붓**이다. 칸마다 1바이트인데
 *    0 은 비었음, 1 이상은 **그 칸을 가리는 방식**이다 (`METHOD_IDS` 의 번호). 방식이
 *    자리마다 다를 수 있어야 하므로 (예전 「박스마다 다른 방식」이 하던 일) 칸이 방식을 든다.
 *
 *  그리는 쪽은 격자를 **큰 사각형들로 덮어** 받는다 (`toRenderBoxes`, 겹쳐도 된다). 렌더러
 *  (`censorRender`)는 사각형 목록만 알고, 스팀은 사각형마다 v2 판을 찍어 최대값으로 모으므로
 *  겹친 사각형은 한 덩이 구름이 된다. 격자를 직접 받는 렌더러를 따로 만들지 않는다 — 한 벌이어야 한다.
 */
import type { RenderBox } from "./censorRender.ts";

export const GRID = 8;

/** 칸에 적는 방식 번호의 순서. ★번호는 **저장되지 않는다**(세션 안에서만) — 순서를 바꿔도 된다 */
export const METHOD_IDS = ["steam", "mosaic", "blur", "black", "white", "color"] as const;

/** 방식 이름 → 칸 값 (1..). 모르는 이름은 첫째(스팀)로 본다 */
export const methodIndex = (m: string | undefined) => {
  const i = METHOD_IDS.indexOf((m ?? "") as (typeof METHOD_IDS)[number]);
  return (i < 0 ? 0 : i) + 1;
};

export const methodOf = (v: number) => METHOD_IDS[v - 1] ?? METHOD_IDS[0];

export type Grid = {
  /** 원본 픽셀 크기 — 사각형을 낼 때 여기서 자른다 (격자는 올림이라 그림보다 클 수 있다) */
  w: number;
  h: number;
  cols: number;
  rows: number;
  /** 칸마다 0(비었음) 또는 방식 번호 */
  cells: Uint8Array;
};

export function makeGrid(w: number, h: number): Grid {
  const cols = Math.max(1, Math.ceil(w / GRID));
  const rows = Math.max(1, Math.ceil(h / GRID));
  return { w, h, cols, rows, cells: new Uint8Array(cols * rows) };
}

export const cloneGrid = (g: Grid): Grid => ({ ...g, cells: new Uint8Array(g.cells) });

export function countCells(g: Grid) {
  let n = 0;
  for (let i = 0; i < g.cells.length; i++) if (g.cells[i]) n++;
  return n;
}

export const isEmpty = (g: Grid | null | undefined) => !g || countCells(g) === 0;

/** 픽셀 자리 → 칸 (격자 안으로 가둔다). ★수가 아니면(그림이 아직 배치되기 전의 NaN) null */
export function cellAt(g: Grid, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    gx: Math.max(0, Math.min(g.cols - 1, Math.floor(x / GRID))),
    gy: Math.max(0, Math.min(g.rows - 1, Math.floor(y / GRID))),
  };
}

/** 찾은 박스를 격자에 굽는다. ★**조금이라도 걸친 칸은 켠다** — 검열은 덜 가리는 쪽이 사고다.
 *  회전은 안 본다 (찾은 박스는 반듯하다). 박스가 방식을 들고 있으면 그것을, 없으면 `fallback` */
export function burnBoxes(
  g: Grid, boxes: { box: [number, number, number, number]; method?: string }[], fallback: string,
): Grid {
  for (const b of boxes) {
    const v = methodIndex(b.method ?? fallback);
    const [x1, y1, x2, y2] = b.box;
    if (x2 <= x1 || y2 <= y1) continue;
    const c0 = Math.max(0, Math.floor(x1 / GRID));
    const c1 = Math.min(g.cols - 1, Math.ceil(x2 / GRID) - 1);
    const r0 = Math.max(0, Math.floor(y1 / GRID));
    const r1 = Math.min(g.rows - 1, Math.ceil(y2 / GRID) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g.cells[r * g.cols + c] = v;
  }
  return g;
}

/** 붓 한 번 — `gx,gy` 를 가운데로 `(2r+1)²` 칸을 `v` 로 (0 이면 지우개).
 *  ★인페인트 붓과 같은 **홀수 변**이다 — 가운데 칸이 있어야 커서 자리와 칠한 자리가 맞는다 */
export function stamp(g: Grid, gx: number, gy: number, r: number, v: number) {
  const R = Math.max(0, Math.round(r));
  for (let y = gy - R; y <= gy + R; y++) {
    if (y < 0 || y >= g.rows) continue;
    for (let x = gx - R; x <= gx + R; x++) {
      if (x < 0 || x >= g.cols) continue;
      g.cells[y * g.cols + x] = v;
    }
  }
}

/** 지난 칸에서 이 칸까지 이어 찍는다 — 브레젠험. 빨리 그으면 점선이 되므로 잇는다 */
export function stroke(
  g: Grid, a: { gx: number; gy: number }, b: { gx: number; gy: number }, r: number, v: number,
) {
  const dx = Math.abs(b.gx - a.gx);
  const dy = Math.abs(b.gy - a.gy);
  /* ★★수가 아닌 칸이 오면 **그냥 끝낸다.** `NaN === NaN` 이 영원히 거짓이라 아래 고리가 안
     끝난다 — 무대가 아직 크기를 못 받아 좌표가 NaN 이던 시험에서 앱이 통째로 멈췄다
     (2026-09-05). 걸음 수에도 천장을 둔다 (dx+dy 를 넘을 수 없다). */
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const sx = a.gx < b.gx ? 1 : -1;
  const sy = a.gy < b.gy ? 1 : -1;
  let err = dx - dy;
  let { gx, gy } = a;
  for (let step = 0; step <= dx + dy; step++) {
    stamp(g, gx, gy, r, v);
    if (gx === b.gx && gy === b.gy) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; gx += sx; }
    if (e2 < dx) { err += dx; gy += sy; }
  }
}

/** 칠한 칸 전부를 한 방식으로 (검열 방식 단추가 「지금 있는 것 전부」에 걸리는 규칙) */
export function remap(g: Grid, v: number) {
  for (let i = 0; i < g.cells.length; i++) if (g.cells[i]) g.cells[i] = v;
  return g;
}

/** 격자를 **큰 사각형들로 덮는다** — 방식이 같은 칸끼리, 사각형은 **겹쳐도 된다**.
 *
 *  ★★왜 쪼개지 않고 덮는가 (사용자 지적 2026-09-05: *"정확한 사각형일 때랑 계단이 많은
 *    사각형일 때랑 그려지는 모습이 너무 달라"*): 겹치지 않게 쪼개면 계단이 있는 자리마다
 *    조각이 잘게 갈리고, 스팀은 조각마다 **그 조각 크기의** 구름을 찍으므로 작은 구름들이
 *    줄지어 붙어 계단이 그대로 드러났다. 칠한 영역 **안에 들어가는 큰 사각형**들로 겹치게
 *    덮으면 사각형마다 제 크기의 구름이 되고, 그것들이 최대값으로 합쳐져(한 덩이) 직각
 *    다각형도 사각형 몇 장이 겹친 구름이 된다. 정확한 사각형은 사각형 하나라 v2 그대로다.
 *  ★모자이크·흐리기·단색은 마스크를 합집합으로 채우므로 겹쳐도 결과가 같다.
 *
 *  방법: 왼쪽 위부터 훑어 아직 안 덮인 칸을 만나면, 그 칸을 품는 사각형 중 점수가 가장 높은
 *  것을 고른다. 점수는 **쪼개지 않고 그릴 수 있는 넓이** — 짧은 변 × (긴 변을 `SPLIT_ASPECT`
 *  배까지만 센 것). 비율을 넘는 긴 띠는 어차피 `splitSquarish` 가 짧은 변 크기로 자르므로,
 *  얇고 긴 띠(3×42)가 넓이로 이겨 놓고 잘게 잘리는 일을 막는다 (실측: 거의 세로인 획).
 *  같은 점수면 넓은 쪽. 사각형 안의 칸은 전부 덮인 것으로 친다.
 *  ★찾은 박스 하나는 사각형 하나로 돌아온다 (격자에 맞춰 넓어진 채로).
 *  ★합집합은 칠한 칸과 정확히 같다 — 사각형은 늘 칠한 칸 안에만 있고, 칸은 빠짐없이 덮인다. */
export function rectsOf(g: Grid): { method: string; box: [number, number, number, number] }[] {
  const { cols, rows, cells } = g;
  const done = new Uint8Array(cells.length);
  const out: { method: string; box: [number, number, number, number] }[] = [];
  /** 행 t 에서 x 를 품고 값이 v 인 가로 줄의 양 끝 (칸, 양쪽 포함) */
  const run = (t: number, x: number, v: number) => {
    const row = t * cols;
    let a = x, b = x;
    while (a > 0 && cells[row + a - 1] === v) a--;
    while (b < cols - 1 && cells[row + b + 1] === v) b++;
    return [a, b];
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const v = cells[i];
      if (!v || done[i]) continue;
      // 위로·아래로 행을 더할수록 좁아지는 가로 범위 (행 y 에서 k 행 떨어진 곳까지의 교집합)
      const upL: number[] = [], upR: number[] = [], dnL: number[] = [], dnR: number[] = [];
      for (let t = y, l = 0, r = cols - 1; t >= 0 && cells[t * cols + x] === v; t--) {
        const [a, b] = run(t, x, v);
        l = Math.max(l, a); r = Math.min(r, b);
        upL.push(l); upR.push(r);
      }
      for (let t = y, l = 0, r = cols - 1; t < rows && cells[t * cols + x] === v; t++) {
        const [a, b] = run(t, x, v);
        l = Math.max(l, a); r = Math.min(r, b);
        dnL.push(l); dnR.push(r);
      }
      let best = 0, bl = x, br = x, bt = y, bb = y;
      for (let u = 0; u < upL.length; u++) {
        for (let d = 0; d < dnL.length; d++) {
          const l = Math.max(upL[u], dnL[d]), r = Math.min(upR[u], dnR[d]);
          const w = r - l + 1, h = u + d + 1;
          const lo = Math.min(w, h), hi = Math.max(w, h);
          const score = lo * Math.min(hi, lo * SPLIT_ASPECT) + w * h * 1e-3;
          if (score > best) { best = score; bl = l; br = r; bt = y - u; bb = y + d; }
        }
      }
      for (let t = bt; t <= bb; t++) done.fill(1, t * cols + bl, t * cols + br + 1);
      out.push({
        method: methodOf(v),
        box: [bl * GRID, bt * GRID, Math.min(g.w, (br + 1) * GRID), Math.min(g.h, (bb + 1) * GRID)],
      });
    }
  }
  return out;
}

/** 씨앗 팔레트의 크기 — 사각형의 씨앗은 이 안의 하나다 */
export const SEEDS = 8;

/** 사각형의 구름 씨앗 — **왼쪽 위 모서리**에서 골라, `SEEDS` 개 중 하나.
 *  ★오른쪽·아래로 더 칠해 사각형이 자라도 씨앗이 그대로라 구름이 통째로 바뀌지 않는다.
 *    (박스 시절에는 박스마다 번호를 붙여 옮겨도 같은 구름이었다 — 붓에는 「옮기기」가 없다.)
 *  ★★왜 팔레트인가 (사용자 지적 2026-09-05: *"기존 박스랑 연결되게 찍으면 엄청 느려짐"*):
 *    무늬 판은 **씨앗별로** 캐시된다. 자리마다 다른 씨앗이면 획이 박스에 닿아 사각형이
 *    다시 잘릴 때마다 새 씨앗이 수십 개 나와 판을 그만큼 새로 구웠다. 여덟이면 비율·배율
 *    버킷과 곱해도 금방 다 채워져 그 뒤로는 캐시만 맞는다. 이웃끼리 같은 씨앗이어도 비율과
 *    배율이 달라 같은 구름으로 보이지 않고, 최대값으로 합쳐지므로 되풀이가 드러나지 않는다. */
export function seedOf(box: [number, number, number, number]) {
  // ★칸 단위로 섞는다 — 픽셀(8의 배수)을 그대로 곱하면 낮은 비트가 늘 0 이라 팔레트가 하나로 뭉친다
  const cx = Math.floor(box[0] / GRID), cy = Math.floor(box[1] / GRID);
  let h = Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy + 0x1000, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return ((h >>> 0) % SEEDS) + 1;
}

/** 이 비율을 넘는 사각형은 조각낸다 (긴 변 ÷ 짧은 변).
 *  ★3 인 이유: 2 로 두면 계단 모양을 덮은 8×30칸 몸통이 8×8 로 잘려 큰 구름이 사라졌다
 *  (2026-09-05). 같은 폭으로 잘린 조각은 **옆면 구름 폭이 한 장일 때와 같고**(짧은 변이 정한다),
 *  비율 3 까지는 타원 끝의 뻗침이 짧은 변 이내라 뾰족해 보이지 않는다. */
export const SPLIT_ASPECT = 3;

/** 길쭉한 사각형을 **정사각형에 가까운 조각**으로 나눈다 — 칸 경계에서.
 *
 *  ★★왜: 스팀은 사각형마다 **그 비율의 타원 구름**을 배율로 키워 찍는다. 지우개로 박스를
 *    가로지르면 가장자리에 8px 폭 × 100px 높이 같은 **조각**이 남는데, 그것이 사각형 하나가
 *    되면 세로로 200px 짜리 뾰족한 구름이 선다 (실측 2026-09-05, 무대 시험). 정사각형에 가까운
 *    조각으로 나누면 조각마다 작은 구름이 되고, 이웃과 최대값으로 합쳐져 능선이 된다.
 *  ★찾은 박스 대부분(비율 2 이내)은 그대로 하나다 — 그 모양은 손대지 않는다.
 *  ★모자이크·흐리기·단색은 사각형을 합집합으로 채우므로 나눠도 결과가 같다. */
export function splitSquarish(box: [number, number, number, number]): [number, number, number, number][] {
  const [x1, y1, x2, y2] = box;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return [];
  if (w <= h * SPLIT_ASPECT && h <= w * SPLIT_ASPECT) return [box];
  const out: [number, number, number, number][] = [];
  if (w > h) {
    const n = Math.ceil(w / h);
    const cells = Math.ceil(w / GRID);
    for (let i = 0; i < n; i++) {
      const a = x1 + Math.floor((cells * i) / n) * GRID;
      const b = i === n - 1 ? x2 : x1 + Math.floor((cells * (i + 1)) / n) * GRID;
      if (b > a) out.push([a, y1, Math.min(b, x2), y2]);
    }
  } else {
    const n = Math.ceil(h / w);
    const cells = Math.ceil(h / GRID);
    for (let i = 0; i < n; i++) {
      const a = y1 + Math.floor((cells * i) / n) * GRID;
      const b = i === n - 1 ? y2 : y1 + Math.floor((cells * (i + 1)) / n) * GRID;
      if (b > a) out.push([x1, a, x2, Math.min(b, y2)]);
    }
  }
  return out;
}

/** 렌더러가 받는 모양으로 — 길쭉한 것은 조각내서 */
export function toRenderBoxes(g: Grid | null | undefined): RenderBox[] {
  if (!g) return [];
  return rectsOf(g).flatMap((r) =>
    splitSquarish(r.box).map((box) => ({ seed: seedOf(box), box, rotation: 0, method: r.method })));
}
