/** 인퍼런스: 인페인트로 흉내 내는 캐릭터 참조. 설계는 `docs/inference-design.md` 다.
 *
 *  참조 그림을 흰 캔버스의 한 변에 가득 붙이고 나머지를 전부 인페인트하면, 모델이 옆의 캐릭터를 보고
 *  같은 캐릭터를 그린다. 결과는 참조 칸을 뺀 자리를 잘라 낸 것이다.
 *
 *  ★★**배치는 여기 한 곳에서 정한다** (설계 문서 5번). 화면은 이 계획을 서버에 싣고, 서버는 받은 숫자대로
 *    그리고 자르기만 한다 (`server._inference_canvas`). 식이 두 곳에 있으면 요금·결과 크기 표시와 실제가 갈린다.
 *  ★숫자는 전부 실측이다 (설계 문서 6번). 상한을 넘으면 결과가 칸 여럿으로 나뉘어 캐릭터가 두 번 그려진다. */
import { FREE_PIXELS } from "./baseSize.ts";

/** 인퍼런스를 켤 수 있는 모델 (사용자 결정 2026-09-29). V5 Curated 는 인페인트가 V4.5 로 떨어져 그림체가 달라진다 */
export const INFERENCE_MODEL = "nai-diffusion-5-full";

/** NAI 가 받는 가장 큰 넓이 */
const MAX_PIXELS = 3_145_728;
/** 결과 칸 ÷ 참조 칸 상한. 옆으로는 2.0 에서 반이 나뉘었고, 위아래로는 2.0 에서 18장 모두 한 장이었다 */
const SIDE_MAX = 1.5;
const TOP_MAX = 2.0;
/** 경계에 생기는 흰 띠를 잘라 내는 폭. 잰 최대는 옆 28 · 위 32 */
const SIDE_CUT = 32;
const TOP_CUT = 40;

export type Rect = { x: number; y: number; w: number; h: number };

export type InferencePlan = {
  /** 참조를 왼쪽에 세우나(`side`), 위에 까나(`top`) */
  place: "side" | "top";
  canvas: { w: number; h: number };
  /** 참조를 그리는 자리 (칸의 한 변에 가득, 칸 가운데) */
  ref: Rect;
  /** 다시 그리지 않는 자리 (참조 칸 전체, 참조 옆의 흰 여백 포함) */
  keep: Rect;
  /** 결과로 잘라 내는 자리 */
  crop: Rect;
};

const ceil8 = (v: number) => Math.ceil(v / 8) * 8;
const floor8 = (v: number) => Math.floor(v / 8) * 8;
const ceil64 = (v: number) => Math.ceil(v / 64) * 64;

/** 참조를 왼쪽에 높이 가득 세운다. `k` 참조 가로/세로 · `a` 결과 가로/세로 · `P` 캔버스 넓이 예산 */
function side(k: number, a: number, P: number): InferencePlan | null {
  let best: { W: number; H: number; c: number; R: number } | null = null;
  for (let H = 64; H <= 4096; H += 64) {
    const R = floor8(a * H);
    const c = ceil8(Math.max(k * H, (R + SIDE_CUT) / SIDE_MAX));
    const W = ceil64(c + R + SIDE_CUT);
    if (W * H <= P) best = { W, H, c, R };
  }
  if (!best) return null;
  const { W, H, R } = best;
  let c = best.c;
  // 64 로 올리며 남은 너비는 결과에 준다. 그러면 상한을 넘을 때만 참조 칸에 준다
  if ((W - c) / c > SIDE_MAX) c = W - R - SIDE_CUT;
  const rw = Math.min(c, Math.round(k * H));
  return {
    place: "side",
    canvas: { w: W, h: H },
    ref: { x: Math.floor((c - rw) / 2), y: 0, w: rw, h: H },
    keep: { x: 0, y: 0, w: c, h: H },
    crop: { x: c + SIDE_CUT, y: 0, w: W - c - SIDE_CUT, h: H },
  };
}

/** 참조를 위에 너비 가득 깐다 (`side` 를 눕힌 것과 같은 식이고 상한·잘라 내는 폭만 다르다) */
function top(k: number, a: number, P: number): InferencePlan | null {
  let best: { W: number; H: number; b: number; R: number } | null = null;
  for (let W = 64; W <= 4096; W += 64) {
    const R = floor8(W / a);
    const b = ceil8(Math.max(W / k, (R + TOP_CUT) / TOP_MAX));
    const H = ceil64(b + R + TOP_CUT);
    if (W * H <= P) best = { W, H, b, R };
  }
  if (!best) return null;
  const { W, H, R } = best;
  let b = best.b;
  if ((H - b) / b > TOP_MAX) b = H - R - TOP_CUT;
  const rh = Math.min(b, Math.round(W / k));
  return {
    place: "top",
    canvas: { w: W, h: H },
    ref: { x: 0, y: Math.floor((b - rh) / 2), w: W, h: rh },
    keep: { x: 0, y: 0, w: W, h: b },
    crop: { x: 0, y: b + TOP_CUT, w: W, h: H - b - TOP_CUT },
  };
}

/** 이 참조로 `w × h` 비율의 결과를 낼 때의 배치. 두 배치를 다 재 보고 결과가 넓은 쪽을 쓴다.
 *
 *  ★`w × h` 는 해상도 칸의 값이다. **비율과 예산**으로만 쓰인다: 1MP 이하면 예산이 1MP(Opus 무료 크기),
 *    넘으면 그 넓이다 (어차피 Anlas 를 내는 크기다). 실제 결과 크기는 `crop` 이다. */
export function planFor(refW: number, refH: number, w: number, h: number): InferencePlan | null {
  if (!refW || !refH || !w || !h) return null;
  const k = refW / refH;
  const a = w / h;
  const P = Math.min(MAX_PIXELS, Math.max(FREE_PIXELS, w * h));
  const s = side(k, a, P);
  const t = top(k, a, P);
  if (!s || !t) return s ?? t;
  return t.crop.w * t.crop.h > s.crop.w * s.crop.h ? t : s;
}
