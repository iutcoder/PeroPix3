/** 스팀(구름) — **순수 계산**이다. 캔버스도 DOM 도 안 쓴다.
 *
 *  ★★★**칠한 자리에서 거리를 재어 만든다** (사용자 지시 2026-09-05: *"겹쳐진 사각형들이
 *    합쳐지는 것처럼"* · *"떨어진 박스는 따로"*).
 *
 *    그 전에는 **박스마다 타원 구름을 따로 그렸다** (v2 원문 `generateSteamTexture` 이식).
 *    그래서 박스를 겹쳐 놓으면 구름 두 덩이가 겹쳐 보였다 — 캔버스에는 「알파의 최대값」으로
 *    합치는 수단이 없어(어떤 블렌드를 써도 알파가 더해진다) 겹친 자리가 밝은 띠로 드러났다.
 *
 *    이제 **가릴 자리 전체를 한 장의 마스크로 모아** 거기서부터의 거리를 재고, 그 거리에
 *    노이즈를 걸어 구름 하나를 만든다. 그래서:
 *      · 겹치거나 닿은 박스는 **자연스럽게 한 덩이**가 된다 (경계선이 없다).
 *      · 멀리 떨어진 박스는 halo 가 안 닿아 **따로 남는다** (같은 지시).
 *      · 마스크가 사각형일 필요가 없다 — 브러시로 칠한 직각 다각형도 같은 코드가 받는다.
 *      · **가릴 자리는 반드시 덮인다.** 마스크 안은 거리가 0 이고 노이즈는 밖으로만 밀기
 *        때문에 어떤 씨앗에서도 알파 255 다 (옛 타원은 모서리를 원리상 못 덮어 73~93% 였다).
 *
 *  ★★v2 에서 그대로 가져온 것: 3옥타브 가장자리 노이즈(가중치 0.5·0.35·0.15), 밝기
 *    노이즈(1·0.5·0.25 → 0.5~1), 회색 230±25, 그리고 「부드럽게」가 무늬를 성기게 하면서
 *    윤곽 흔들림을 약하게 하는 성질.
 *
 *  ★★★**넘치는 폭이 절대값이 됐다.** 구름이 칠한 자리 밖으로 나가는 폭은 `cloudReach` 가
 *    정하는 **픽셀 값**이다 (사용자 요구 2026-09-04: *"박스 크기랑 상관없이 절대값으로는
 *    못 하나"*). 타원이던 때는 모서리를 덮으려면 반지름이 반폭의 √2 배 이상이어야 해서
 *    넘치는 폭이 박스에 비례할 수밖에 없었는데, 거리로 재면 그 제약이 사라진다.
 */
import { makeNoise, smoothstep } from "./noise.ts";

/** 구름이 실제로 뻗는 폭 ÷ `cloudReach` — 아래 세 몫(둥글리기·부풀림·경사)을 더한 값이다 */
const EXTENT = 1.9;
/** 도형 짧은 변 대비 뻗는 폭. ★**이만큼은 있어야 안개로 읽힌다** (아래 ★★주) */
const EXTENT_RATIO = 1.0;
/* ★0.78 로 뽑아 봤더니 긴 변이 아직 곧게 비쳤다 (2026-09-05 렌더 대조). 1.0 에서 덩어리가
   변 길이에 맞먹어 네모가 사라진다. */
/** 뻗는 폭의 바닥·천장 (원본 픽셀) */
const EXTENT_MIN = 60;
const EXTENT_MAX = 300;

/** ★★**구름 크기의 단위** (원본 픽셀). 실제로 뻗는 폭은 이 값의 약 `EXTENT` 배다.
 *
 *  ★★**안개로 읽히려면 뻗는 폭이 도형 크기에 견줄 만해야 한다** (사용자 지적 2026-09-05:
 *    *"예전처럼 네모박스가 됨 … 불균일한 안개 느낌을 유지"*). 한때 이 폭을 34~84px 로 **못
 *    박았는데**(절대값), 그러면 200px 짜리 박스에서 덩어리가 변 길이보다 훨씬 작아 **직선 변이
 *    그대로 드러났다.** 덩어리는 폭에 비례하므로, 폭이 작으면 무슨 짓을 해도 네모로 보인다.
 *  ★대신 **천장을 둔다** — 큰 박스에서 자리를 너무 먹지 않게 (2026-09-04 지적).
 *
 *      짧은 변    뻗는 폭(한쪽)   그린 크기
 *        60px        60px        박스의 3.0배
 *       150px       150px             3.0배
 *       300px       300px             3.0배
 *       800px       300px             1.75배
 *      2000px       300px             1.30배
 */
export function cloudReach(shortSide: number): number {
  const ext = Math.min(EXTENT_MAX, Math.max(EXTENT_MIN, Math.max(0, shortSide) * EXTENT_RATIO));
  return ext / EXTENT;
}

/** 회색 범위 — **v2 원문 그대로** (`floor(b*230) + floor(bright * floor(b*25))`).
 *  ★230 을 바탕으로 25 단계만 흔든다. 거의 흰색이고, 그것이 이 구름의 원래 성격이다. */
const GRAY_BASE = 230;
const GRAY_RANGE = 25;

export type Cloud = {
  /** 덮는 정도 0..255 */
  cover: Uint8Array;
  /** 구름의 두께(밝기) 0..255. 밝기 슬라이더가 이 값을 편다 */
  lum: Uint8Array;
  w: number;
  h: number;
};

export type CloudOpts = {
  seed: number;
  /** 0~50. 무늬를 성기게 하고 윤곽 흔들림을 약하게 한다 (v2 그대로) */
  feather: number;
  /** 구름 크기의 단위 — **이 격자의 픽셀 단위**. 실제로 뻗는 폭은 이 값의 약 1.9배 */
  reach: number;
};

/** 마스크를 흐려 **둥글린다** — 상자 흐리기 두 번(≈가우시안). 결과는 0..1.
 *
 *  ★★왜 필요한가: 사각형에서 잰 거리는 등고선이 **모서리만 둥근 사각형**이라, 긴 변이
 *    그대로 직선으로 남는다. 노이즈를 아무리 걸어도 그 직선이 비쳐 「네모」로 읽힌다
 *    (사용자 지적 2026-09-05). 거리를 재기 **전에** 모양을 뭉개면 바탕부터 둥글다.
 *  ★칠한 자리는 그대로 합집합에 넣는다 (`mask || 뭉갠 것`) — 덮임 보장이 여기 걸려 있다.
 *  ★가장자리는 **바깥값을 되풀이**한다 (0 으로 보면 판 테두리에서 모양이 잘린다). */
function roundedBase(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const R = Math.max(1, Math.round(r));
  let cur = Float32Array.from(mask);
  const tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -R; x <= R; x++) sum += cur[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = sum / (2 * R + 1);
        sum += cur[y * w + Math.min(w - 1, x + R + 1)] - cur[y * w + Math.max(0, x - R)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -R; y <= R; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = sum / (2 * R + 1);
        sum += tmp[Math.min(h - 1, y + R + 1) * w + x] - tmp[Math.max(0, y - R) * w + x];
      }
    }
  }
  const base = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) base[i] = mask[i] || cur[i] > 0.28 ? 1 : 0;
  return base;
}

/** 마스크(0/1) **밖으로의 거리**. 안쪽은 0 이다.
 *
 *  ★두 번 훑는 체임퍼 거리다 (이웃 여덟). 정확한 유클리드는 아니지만 오차가 몇 % 안쪽이고,
 *    그 위에 노이즈를 얹으므로 눈에 안 잡힌다. 픽셀당 상수 시간이라 빠르다. */
export function distanceOutside(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF;
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (y > 0) v = Math.min(v, d[i - w] + D1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + D2);
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + D2);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + D1);
      if (y < h - 1) v = Math.min(v, d[i + w] + D1);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + D2);
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + D2);
      d[i] = v;
    }
  }
  return d;
}

/** 마스크에서 구름 하나를 만든다.
 *
 *  ★★번지는 폭(`reach`)을 셋이 나눠 쓴다. 셋을 더하면 언제나 `reach` 라, 「부드럽게」를
 *    아무리 올려도 **구름이 닿는 끝은 그대로다** (2026-08-23 사용자 지적으로 정해진 성질).
 *
 *      solid  칠한 자리 밖으로 **완전히 덮는** 띠
 *      bulge  노이즈가 윤곽을 **밖으로만** 미는 폭 (안으로는 안 판다 — 안쪽이 100% 여야 한다)
 *      halo   그 바깥의 부드러운 경사
 */
export function cloudFromMask(mask: Uint8Array, w: number, h: number, o: CloudOpts): Cloud {
  const reach = Math.max(1, o.reach);
  const soft = Math.min(50, Math.max(0, o.feather)) / 50;
  /* ★「부드럽게」를 올리면 덩어리가 잦아들고(bulge↓) 경사가 넓어진다(halo↑) — v2 와 같은 방향.
     ★셋을 더하면 `EXTENT` 배가 된다 (둥글리기 0.45 + 부풀림 0.85 + 경사 0.6). */
  const roundR = reach * 0.45;
  const bulge = reach * (0.85 - soft * 0.45);
  const halo = reach * (0.6 + soft * 0.5);
  /** 경사 폭을 자리마다 흔드는 정도 — 한결같은 띠가 아니라 들쭉날쭉한 안개가 된다 */
  const vary = 0.55 - soft * 0.2;
  /** 바깥으로 갈수록 알파에 얼룩을 주는 정도 */
  const patch = 0.45 - soft * 0.15;

  const n = makeNoise(o.seed);
  /** 경사·얼룩을 흔드는 두 번째 무늬 — 윤곽과 같은 자리에서 흔들리면 결이 겹쳐 보인다 */
  const nd = makeNoise(o.seed * 3 + 17);
  /* ★★**덩어리는 크게** — v2 의 비례를 옮긴 값이다 (짧은 변 140px 에서 파장 146·73·35px).
     처음엔 파장을 `reach` 의 1.5배로 잡았다가 **잔털 난 네모**가 됐다 — 직선 변을 흔들려면
     파장이 변 길이에 맞먹어야 한다. */
  const ns = reach * 5 * (1 + soft * 0.5);
  const lumScale = reach * 6;
  const cap = reach * EXTENT;

  const d = distanceOutside(roundedBase(mask, w, h, roundR), w, h);
  const cover = new Uint8Array(w * h);
  const lum = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // ── 구름의 두께 (거의 흰색, 13계조만 흔들린다) ──────────────
      let bn = n(x / lumScale, y / lumScale)
        + n((x / lumScale) * 2, (y / lumScale) * 2) * 0.5
        + n((x / lumScale) * 4, (y / lumScale) * 4) * 0.25;
      bn = 0.5 + ((bn / 1.75 + 1) / 2) * 0.5;
      lum[i] = Math.round(bn * 255);

      const dist = d[i];
      if (dist > cap) continue;             // 닿는 끝 밖 — 완전히 투명하다
      // ── 덮는 범위 ──────────────────────────────────────────
      // ★v2 의 3옥타브 가장자리 노이즈. **밖으로만** 민다 (`max(0, …)`) — 안으로 파이면
      //   칠한 자리가 드러난다. 이 한 줄이 「반드시 덮인다」를 지킨다.
      const en = n(x / (ns * 0.5) + 50, y / (ns * 0.5) + 50) * 0.5
        + n(x / (ns * 0.25) + 150, y / (ns * 0.25) + 150) * 0.35
        + n(x / (ns * 0.12) + 250, y / (ns * 0.12) + 250) * 0.15;
      const edge = Math.max(0, en) * bulge;
      // ★경사 폭도 자리마다 다르다 — 어디는 뚝 끊기고 어디는 길게 흩어져야 안개로 읽힌다
      const hv = halo * (1 - vary + vary * (nd(x / (ns * 0.35), y / (ns * 0.35)) + 1));
      let a = dist <= edge ? 1 : 1 - smoothstep(edge, edge + hv, dist);
      if (patch > 0 && dist > edge) {
        // ★바깥으로 갈수록 얼룩이 세진다 — 안쪽은 건드리지 않는다 (덮임 보장)
        const pk = (nd(x / (ns * 0.18) + 90, y / (ns * 0.18) + 90) + 1) / 2;
        a *= 1 - patch * (1 - pk) * Math.min(1, (dist - edge) / Math.max(1, hv));
      }
      cover[i] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  return { cover, lum, w, h };
}

/** 구름에 **밝기·진하기**를 입혀 RGBA 로. 픽셀당 곱셈이라 슬라이더가 안 걸린다.
 *
 *  `out` 을 주면 거기에 쓴다 (매 프레임 새 배열을 만들지 않기 위해). */
export function cloudRGBA(
  c: Cloud, brightness: number, alpha: number, out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const n = c.w * c.h;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const b = Math.min(100, Math.max(0, brightness)) / 100;
  const a = Math.min(100, Math.max(0, alpha)) / 100;
  const base = Math.floor(GRAY_BASE * b);
  const range = Math.floor(GRAY_RANGE * b);
  for (let i = 0; i < n; i++) {
    const g = base + Math.floor((c.lum[i] / 255) * range);
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = c.cover[i] * a;
  }
  return rgba;
}
