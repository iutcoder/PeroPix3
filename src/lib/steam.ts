/** 스팀(구름) 텍스처 — **순수 계산**이다. 캔버스도 DOM 도 안 쓴다.
 *
 *  ★★★**v2 의 모양으로 되돌렸다** (사용자 결정 2026-09-04: *"그냥 v2 원본이 제일 나은듯 …
 *    형태 자체는 저렇게 퍼지게 두고, 기본적으로 좀 더 넓게 그리게 해서 박스를 90% 이상 가리게"*).
 *    원문은 v2 `index.html` 의 `generateSteamTexture` — **타원 거리 + 3옥타브 가장자리 노이즈 +
 *    `0.6 → 1.15` 알파 경사**다. 아래 계산은 그 순서와 상수를 그대로 옮긴 것이다.
 *
 *  ★★그 사이에 있던 「둥근 사각형 바탕 + 바깥으로만 부푸는 윤곽」은 **걷어냈다.**
 *    박스를 100% 덮으려고 바탕을 사각형으로 잡았는데, 그 바탕이 그대로 비쳐
 *    *"어떻게 조정해도 기본이 네모"* 라는 제보가 왔다 (2026-09-02). 덮는 것은
 *    **모양이 아니라 배율**로 푼다 (`CLOUD_SCALE`).
 *
 *  ★★v2 와 **다른 것은 딱 둘**이다:
 *    1. `CLOUD_SCALE` — 구름을 그만큼 크게 그린다. v2 는 박스의 30% 밖에 못 덮었다.
 *    2. 무늬를 **판 좌표**에서 만든다 (v2 는 박스의 실제 픽셀 좌표였다). v2 는 박스 크기를
 *       조금만 바꿔도 무늬가 통째로 달라졌는데(사용자 지적 2026-09-04: *"비율이 고정되면서
 *       바뀌는 게 아니고 엄청 크게 바뀌는"*), 판을 고정 해상도로 만들어 늘려 쓰면
 *       **크기를 바꿔도 같은 구름이 커지기만 한다.**
 *
 *  구조 — **재료와 모양을 가른다.** 여기가 빠른 까닭이다:
 *
 *      무늬  씨앗·부드럽게·비율에만 매인다. `plate()` 가 만들어 **캐시**한다.
 *      색    밝기·진하기는 슬라이더라 매 프레임 바뀐다. `plateRGBA()` 가 픽셀당 곱셈 하나로 입힌다.
 */
import { fbm, makeNoise, sdRoundRect, smoothstep } from "./noise.ts";

/** 판의 긴 변 (픽셀). ★비용이 여기 걸린다 — 픽셀마다 노이즈를 여섯 번 돈다.
 *  640 이면 한 장에 약 40ms 이고 (실측 2026-09-04), 캐시되므로 끄는 동안에는 0 이다.
 *  ★이 안에서 **박스가 차지하는 것은 `640 / SPAN`** 이다 — 그만큼이 실제 해상도다. */
const PLATE_MAX = 640;

/** v2 의 `expandRatio` — 판은 구름 박스보다 각 변으로 이만큼 넓다 */
const EXPAND = 0.35;

/** ★★**구름을 박스보다 몇 배로 그리나** (사용자 지시 2026-09-04: 박스를 90% 이상 가리게).
 *
 *  v2 의 타원은 박스에 내접하므로 모서리를 원리상 못 덮는다 — 그래서 **구름 자체를 키운다.**
 *  실측 2026-09-04 — **이 함수로** 잰 값이다 (다섯 비율 × 여덟 씨앗, 가장 나쁜 조건인
 *  「부드럽게 0」. 다시 재려면 이 상수만 바꿔 `steam.test.ts` 의 덮임 판정을 돌린다):
 *
 *      배율    덮임 중앙값   덮임 최저    그리는 크기
 *      ×1.5        68%         60%      박스의 2.55배
 *      ×1.7        83%         73%            2.89배
 *      ×1.9        91%         84%            3.23배
 *      ×2.1        96%         93%            3.57배   ← 지금 값
 *
 *  ★★**「90% 이상」을 최저 기준으로 읽었다.** 그래서 보통 그림에서는 96% 를 덮고, 사용자
 *    눈에는 *"박스를 다 덮고도 초과"* 로 보인다 (지적 2026-09-04). 중앙값을 90% 에 맞추면
 *    (×1.9) **최저가 84% 로 떨어져 어떤 그림에서는 박스의 1/6 이 비친다** — 검열에서
 *    「가려진 줄 알았는데 안 가려진」 것이 가장 나쁜 결함이라 최저 쪽을 기준으로 뒀다.
 *    더 줄일지는 사용자가 정한다.
 *  ★구름이 커 보이는 몫은 대부분 **알파 경사(0.6→1.15)의 halo** 다. 더 줄이려면 배율이
 *    아니라 그 경사를 좁혀야 하는데, 그러면 v2 의 부드러운 느낌이 함께 사라진다.
 *  ★올리면 더 덮이지만 구름이 그만큼 커진다 (그림에서 차지하는 자리가 넓어진다). */
const CLOUD_SCALE = 2.1;

/** 판을 **박스 크기의 몇 배로 그리나**. 부르는 쪽이 이 값으로 그릴 자리를 셈한다 */
export const SPAN = (1 + 2 * EXPAND) * CLOUD_SCALE;

export type Plate = {
  /** 덮는 정도 0..255 */
  cover: Uint8Array;
  /** 구름의 두께(밝기) 0..255. 밝기 슬라이더가 이 값을 편다 */
  lum: Uint8Array;
  /** 판의 픽셀 크기 */
  pw: number;
  ph: number;
  /** 박스 크기의 몇 배로 그리나 (가로·세로 같다 — v2 의 확장이 각 변 비례라서) */
  span: number;
};

/** 이 판이 무엇으로 만들어졌나 — 캐시 열쇠 */
export type PlateKey = { seed: number; feather: number; aspect: number };

/** 가로세로비를 **5% 단위로 뭉갠다.** 늘리는 동안 판을 다시 만들지 않기 위한 것이고,
 *  5% 는 눈에 안 띈다 (판을 그 비율로 늘려 쓴다). */
export const bucketAspect = (w: number, h: number) =>
  Math.max(0.05, Math.round((w / Math.max(h, 1e-6)) * 20) / 20);

/** 무늬 판 하나를 만든다. ★비싸다 — 부르는 쪽이 캐시한다 (`censorRender`).
 *
 *  ★아래 상수는 **전부 v2 원문의 값**이다. 하나만 만져도 구름의 성격이 바뀌므로,
 *    바꿀 때는 무엇을 왜 바꾸는지 여기 적는다. */
export function plate(key: PlateKey): Plate {
  const { seed, feather } = key;
  const aspect = Math.max(0.05, key.aspect);

  // 판 크기 — 긴 변이 `PLATE_MAX`. 그 안에서 구름 박스는 `1 / (1+2*EXPAND)` 를 차지한다
  const tw = Math.max(8, aspect >= 1 ? PLATE_MAX : Math.round(PLATE_MAX * aspect));
  const th = Math.max(8, aspect >= 1 ? Math.round(PLATE_MAX / aspect) : PLATE_MAX);
  const ws = tw / (1 + 2 * EXPAND);
  const hs = th / (1 + 2 * EXPAND);
  const expandX = ws * EXPAND;
  const expandY = hs * EXPAND;

  const n = makeNoise(seed);
  // ★「부드럽게」가 하는 일 둘 (v2 그대로): 무늬를 성기게(1x~3x) · 윤곽 흔들림을 약하게(100%~20%)
  const ff = 1 + Math.min(50, Math.max(0, feather)) / 25;
  const ns = (Math.max(tw, th) / 2) * ff;
  const strength = 1 - Math.min(50, Math.max(0, feather)) / 62.5;

  const rx = ws / 2, ry = hs / 2;
  const cx = tw / 2, cy = th / 2;
  // 판 테두리 — 여기까지는 비우고, 그 바깥 네 배까지 서서히 지운다 (v2 그대로)
  const safe = Math.min(expandX, expandY) * 0.25;
  const fadeEnd = safe * 4;

  const cover = new Uint8Array(tw * th);
  const lum = new Uint8Array(tw * th);

  for (let py = 0; py < th; py++) {
    for (let px = 0; px < tw; px++) {
      const i = py * tw + px;
      const edge = Math.min(px, py, tw - 1 - px, th - 1 - py);
      if (edge < safe) continue;   // 판 테두리는 완전히 투명하다

      // ── 구름의 두께 (거의 흰색, 13계조만 흔들린다) ──────────────
      let bn = n(px / ns, py / ns)
        + n((px / ns) * 2, (py / ns) * 2) * 0.5
        + n((px / ns) * 4, (py / ns) * 4) * 0.25;
      bn = 0.5 + ((bn / 1.75 + 1) / 2) * 0.5;
      lum[i] = Math.round(bn * 255);

      // ── 덮는 범위 ──────────────────────────────────────────
      // ★타원 거리 — 1 이 구름 박스의 테두리다 (원래 박스는 그 `1/CLOUD_SCALE` 자리에 있다)
      const dx = (px - cx) / rx, dy = (py - cy) / ry;
      const dist = Math.hypot(dx, dy);
      // ★3옥타브 가장자리 노이즈 — **양쪽으로** 민다 (안으로 파이는 것도 v2 의 모양이다)
      const en = n(px / (ns * 0.5) + 50, py / (ns * 0.5) + 50) * 0.5
        + n(px / (ns * 0.25) + 150, py / (ns * 0.25) + 150) * 0.35
        + n(px / (ns * 0.12) + 250, py / (ns * 0.12) + 250) * 0.15;
      const warped = dist + en * 0.25 * strength;

      let a = 0;
      if (warped < 0.6) a = 255;
      else if (warped < 1.15) {
        const t = (warped - 0.6) / 0.55;
        a = Math.round((1 - t * t * (3 - 2 * t)) * 255);
      }
      if (edge < fadeEnd) a = Math.round(a * Math.max(0, Math.min(1, (edge - safe) / (fadeEnd - safe))));
      cover[i] = a;
    }
  }
  return { cover, lum, pw: tw, ph: th, span: SPAN };
}

/** 회색 범위 — **v2 원문 그대로** (`floor(b*230) + floor(bright * floor(b*25))`).
 *  ★230 을 바탕으로 25 단계만 흔든다. 거의 흰색이고, 그것이 이 구름의 원래 성격이다. */
const GRAY_BASE = 230;
const GRAY_RANGE = 25;

/** 무늬 판에 **밝기·진하기**를 입혀 RGBA 로 만든다. 픽셀당 곱셈이라 슬라이더가 안 걸린다.
 *
 *  `out` 을 주면 거기에 쓴다 (매 프레임 새 배열을 만들지 않기 위해). */
export function plateRGBA(
  p: Plate, brightness: number, alpha: number, out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const n = p.pw * p.ph;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const b = Math.min(100, Math.max(0, brightness)) / 100;
  const a = Math.min(100, Math.max(0, alpha)) / 100;
  const base = Math.floor(GRAY_BASE * b);
  const range = Math.floor(GRAY_RANGE * b);
  for (let i = 0; i < n; i++) {
    const g = base + Math.floor((p.lum[i] / 255) * range);
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = p.cover[i] * a;
  }
  return rgba;
}

// 바탕 계산은 다른 방식(모자이크·흐리기 마스크)이 쓴다 — 여기서는 안 쓴다
void sdRoundRect;
void smoothstep;
void fbm;
