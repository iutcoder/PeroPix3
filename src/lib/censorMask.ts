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
 *  그리는 쪽은 격자를 **사각형들로 쪼개** 받는다 (`toRenderBoxes`). 렌더러(`censorRender`)는
 *  사각형 목록만 알고, 스팀은 사각형마다 v2 판을 찍어 최대값으로 모으므로 이어진 칸은
 *  한 덩이 구름이 된다. 격자를 직접 받는 렌더러를 따로 만들지 않는다 — 한 벌이어야 한다.
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

/** 픽셀 자리 → 칸 (격자 안으로 가둔다) */
export function cellAt(g: Grid, x: number, y: number) {
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
  const sx = a.gx < b.gx ? 1 : -1;
  const sy = a.gy < b.gy ? 1 : -1;
  let err = dx - dy;
  let { gx, gy } = a;
  for (;;) {
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

/** 격자를 **사각형들로 쪼갠다** — 방식이 같은 칸끼리, 탐욕으로 가장 넓은 것부터.
 *
 *  왼쪽 위부터 훑어, 오른쪽으로 갈 수 있는 데까지 넓히고 그 폭이 통째로 이어지는 만큼
 *  아래로 늘린다. 사각형끼리 겹치지 않고, 합치면 칠한 칸과 정확히 같다.
 *  ★찾은 박스 하나는 사각형 하나로 돌아온다 (격자에 맞춰 넓어진 채로). 붓으로 그은 대각선은
 *    계단이 되어 작은 사각형 여럿이 되는데, 스팀은 그것들을 최대값으로 모으므로 한 덩이다. */
export function rectsOf(g: Grid): { method: string; box: [number, number, number, number] }[] {
  const seen = new Uint8Array(g.cells.length);
  const out: { method: string; box: [number, number, number, number] }[] = [];
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const i = y * g.cols + x;
      const v = g.cells[i];
      if (!v || seen[i]) continue;
      let w = 1;
      while (x + w < g.cols && g.cells[i + w] === v && !seen[i + w]) w++;
      let h = 1;
      outer: while (y + h < g.rows) {
        const row = (y + h) * g.cols + x;
        for (let k = 0; k < w; k++) if (g.cells[row + k] !== v || seen[row + k]) break outer;
        h++;
      }
      for (let r = 0; r < h; r++) seen.fill(1, (y + r) * g.cols + x, (y + r) * g.cols + x + w);
      out.push({
        method: methodOf(v),
        box: [x * GRID, y * GRID, Math.min(g.w, (x + w) * GRID), Math.min(g.h, (y + h) * GRID)],
      });
    }
  }
  return out;
}

/** 사각형의 구름 씨앗 — **왼쪽 위 모서리**에서 만든다.
 *  ★오른쪽·아래로 더 칠해 사각형이 자라도 씨앗이 그대로라 구름이 통째로 바뀌지 않는다.
 *    (박스 시절에는 박스마다 번호를 붙여 옮겨도 같은 구름이었다 — 붓에는 「옮기기」가 없다.) */
export function seedOf(box: [number, number, number, number]) {
  const a = Math.imul(box[0] | 0, 73856093) ^ Math.imul(box[1] | 0, 19349663);
  return ((a >>> 0) % 1_000_000_007) + 1;
}

/** 이 비율을 넘는 사각형은 조각낸다 (긴 변 ÷ 짧은 변) */
export const SPLIT_ASPECT = 2;

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
