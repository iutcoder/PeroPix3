/** 만화 페이지의 **효과음** — 순수 계산 (DOM 없음). 설계 `docs/comic-editor-design.md` 7번 · 9-2번.
 *
 *  ★글꼴로 굽는 글자다 (이미지 팩이 아니다): 글·글꼴·색을 언제든 바꾸고 한·일·영을 다 쓴다.
 *  ★글자마다 따로 놓는다 — 흔들림(크기·회전·자리)과 곡선 배치가 글자 단위라서. 흔들림은 `seed` 로 정해져 다시 구워도 같다.
 *  ★외곽선 두 겹(안쪽·바깥)은 **글 전체를 한 번에** 긋는다 — 이웃 글자의 외곽선이 한 덩어리로 붙어야 효과음답다.
 *  픽셀로 굽는 것은 `pixels.ts` 의 `bakeSfx`, 상태는 `store.ts`.
 *  ★판정: `node --experimental-strip-types src/editor/sfx.test.ts` */
import type { Rect } from "./model";

export type SfxMeta = {
  value: string;
  /** CSS 글꼴 목록 (첫 이름이 주 글꼴). 주 글꼴에 없는 글자는 대체 글꼴로 넘긴다 (`SFX_FALLBACK`) */
  font: string;
  /** 글자 크기 (px) */
  size: number;
  bold: boolean;
  /** 채움 — `fill2` 가 있으면 위(`fill`) → 아래(`fill2`) 그라데이션 */
  fill: string;
  fill2: string | null;
  /** 외곽선 두 겹 — 두께는 글자 크기에 대한 비 (0 이면 없음). 안쪽이 먼저 붙고 바깥이 그 밖을 두른다 */
  inner: number;
  innerColor: string;
  outer: number;
  outerColor: string;
  /** 그림자 — 글자 크기에 대한 비 (오른쪽 아래로 민다). 0 이면 없음 */
  shadow: number;
  shadowColor: string;
  /** 기울기 (도, 오른쪽으로 누우면 음수) */
  skew: number;
  /** 글자별 흔들림 0~1 */
  jitter: number;
  seed: number;
  /** 곡선 배치 -1~1 (0 = 곧게, 1 = 위로 반원쯤 휜다, 음수는 아래로) */
  arc: number;
  /** 자간 — 글자 크기에 대한 비 */
  spacing: number;
  /** 세로쓰기 */
  vertical: boolean;
  /** 고른 스타일 (화면 표시용) */
  style: SfxStyleId | "custom";
};

/** 주 글꼴에 없는 글자를 그릴 글꼴 — 앱에 번들된 것 (한글 11,172자 · ♡♥ 를 다 가진다) */
export const SFX_FALLBACK = "'Pretendard Variable', Pretendard";

/* ── 스타일 프리셋 (설계 7번: 충격 · 속도 · 떨림 · 달콤함 · 공포) ─────────────── */

export const SFX_STYLES = ["impact", "speed", "shake", "sweet", "horror"] as const;
export type SfxStyleId = (typeof SFX_STYLES)[number];

/** 스타일 한 벌 — 글꼴은 글의 문자(한글·가나·그 밖)로 고른다. 글꼴 이름은 만화 글꼴 묶음의 family 이다
 *  (아직 안 받았으면 캔버스가 대체 글꼴로 그렸다가 받은 뒤 다시 굽는다) */
export type SfxStyle = Omit<SfxMeta, "value" | "font" | "size" | "seed" | "style"> & { fonts: { ko: string; ja: string; en: string } };

export const STYLE_PRESETS: Record<SfxStyleId, SfxStyle> = {
  // 충격 — 검은 굵은 글자에 두꺼운 흰 테, 얇은 검은 바깥선. 조금 흔들리고 앞으로 기운다
  impact: {
    fonts: { ko: "'Black Han Sans'", ja: "'Dela Gothic One'", en: "'Bangers'" },
    bold: false, fill: "#111111", fill2: null, inner: 0.13, innerColor: "#ffffff", outer: 0.035, outerColor: "#111111",
    shadow: 0, shadowColor: "#000000", skew: -8, jitter: 0.35, arc: 0, spacing: -0.04, vertical: false,
  },
  // 속도 — 크게 눕히고 붙여 쓴다
  speed: {
    fonts: { ko: "'Do Hyeon'", ja: "'RocknRoll One'", en: "'Bangers'" },
    bold: false, fill: "#111111", fill2: null, inner: 0.1, innerColor: "#ffffff", outer: 0.03, outerColor: "#111111",
    shadow: 0, shadowColor: "#000000", skew: -20, jitter: 0.1, arc: 0, spacing: -0.08, vertical: false,
  },
  // 떨림 — 흰 글자에 검은 선, 많이 흔들린다
  shake: {
    fonts: { ko: "'Jua'", ja: "'Rampart One'", en: "'Luckiest Guy'" },
    bold: false, fill: "#ffffff", fill2: null, inner: 0.07, innerColor: "#111111", outer: 0, outerColor: "#111111",
    shadow: 0, shadowColor: "#000000", skew: 0, jitter: 0.8, arc: 0, spacing: 0.06, vertical: false,
  },
  // 달콤함 — 분홍 그라데이션, 흰 테와 진분홍 바깥선, 살짝 휜다
  sweet: {
    fonts: { ko: "'Jua'", ja: "'Mochiy Pop One'", en: "'Luckiest Guy'" },
    bold: false, fill: "#ff6fa6", fill2: "#ffb8d4", inner: 0.12, innerColor: "#ffffff", outer: 0.035, outerColor: "#c2185b",
    shadow: 0, shadowColor: "#000000", skew: 0, jitter: 0.2, arc: 0.25, spacing: 0.02, vertical: false,
  },
  // 공포 — 붓글씨, 검정에서 검붉은 색으로, 번지는 그림자
  horror: {
    fonts: { ko: "'East Sea Dokdo'", ja: "'Hachi Maru Pop'", en: "'Luckiest Guy'" },
    bold: false, fill: "#141414", fill2: "#5a0a14", inner: 0.06, innerColor: "#ffffff", outer: 0, outerColor: "#111111",
    shadow: 0.05, shadowColor: "#5a0a14", skew: 6, jitter: 0.45, arc: 0, spacing: 0.1, vertical: false,
  },
};

/** 글의 문자 — 한글이 있으면 ko, 가나·한자가 있으면 ja, 아니면 en */
export function scriptOf(s: string): "ko" | "ja" | "en" {
  if (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(s)) return "ko";
  if (/[぀-ヿ一-鿿ｦ-ﾟ]/.test(s)) return "ja";
  return "en";
}

/** 스타일을 건 효과음 — 글·크기·흔들림 씨앗은 그대로 두고 나머지를 스타일 것으로 */
export function withStyle(m: SfxMeta, id: SfxStyleId): SfxMeta {
  const { fonts, ...rest } = STYLE_PRESETS[id];
  return { ...m, ...rest, font: fonts[scriptOf(m.value)], style: id };
}

/** 새 효과음 — 스타일 하나로 */
export function newSfx(value: string, size: number, id: SfxStyleId, seed: number): SfxMeta {
  return withStyle({ value, font: "", size, bold: false, fill: "#111111", fill2: null, inner: 0, innerColor: "#ffffff", outer: 0, outerColor: "#111111",
    shadow: 0, shadowColor: "#000000", skew: 0, jitter: 0, seed, arc: 0, spacing: 0, vertical: false, style: id }, id);
}

/* ── 글자 배치 ───────────────────────────────────────────────── */

function rng(seed: number) {
  let s = Math.max(1, Math.floor(Math.abs(seed)) % 2147483646) || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** 글자 하나의 자리 — 가운데(`x`,`y`, 효과음 원점 기준) · 크기 · 회전(도) · 글꼴 */
export type Glyph = { ch: string; x: number; y: number; size: number; rot: number; font: string; w: number };

/** 글자를 놓는다. `measure(ch, size, font)` 는 그 글자의 폭, `pick(ch, font)` 는 그 글자를 그릴 글꼴 (주 글꼴에 없으면 대체) */
export function layoutSfx(
  m: SfxMeta,
  measure: (ch: string, size: number, font: string) => number,
  pick: (ch: string, font: string) => string = (_c, f) => f,
): Glyph[] {
  const chars = [...m.value.replace(/\s*\n\s*/g, " ")];
  const r = rng(m.seed || 1);
  const j = Math.max(0, Math.min(1, m.jitter));
  const raw = chars.map((ch) => {
    const a = r(), b = r(), c = r();
    const size = m.size * (1 + j * 0.34 * (a - 0.5) * 2);
    const font = pick(ch, m.font);
    const w = ch.trim() ? measure(ch, size, font) : m.size * 0.35;
    return { ch, size, font, w, rot: j * 16 * (b - 0.5) * 2, off: j * 0.16 * m.size * (c - 0.5) * 2 };
  });
  const gap = m.spacing * m.size;
  // 곧게 놓은 자리 (가로쓰기: x 로, 세로쓰기: y 로) — 가운데가 원점
  const adv = raw.map((g) => (m.vertical ? g.size * 1.02 : g.w) + gap);
  const total = adv.reduce((s, v) => s + v, 0) - gap;
  let at = -total / 2;
  const straight = raw.map((g, i) => {
    const mid = at + (adv[i] - gap) / 2;
    at += adv[i];
    return { ...g, mid };
  });
  const arc = Math.max(-1, Math.min(1, m.arc));
  if (Math.abs(arc) < 1e-3 || m.vertical) {
    return straight.map((g) => ({
      ch: g.ch, size: g.size, font: g.font, w: g.w, rot: g.rot,
      x: m.vertical ? g.off : g.mid,
      y: m.vertical ? g.mid : g.off,
    }));
  }
  // 호를 따라 — 글 길이가 호 길이. arc=1 이면 반원 (중심각 π)
  const theta = Math.PI * arc;
  const R = total / theta;
  // 원의 중심은 (0, R) 쪽 (arc>0 이면 아래, 글이 위로 볼록)
  return straight.map((g) => {
    const t = g.mid / R;
    const x = R * Math.sin(t) + g.off * Math.sin(t);
    const y = R * (1 - Math.cos(t)) - g.off * Math.cos(t);
    return { ch: g.ch, size: g.size, font: g.font, w: g.w, rot: g.rot + (t * 180) / Math.PI, x, y: y - (R * (1 - Math.cos(theta / 2))) / 2 };
  });
}

/** 외곽선·그림자·기울기까지 담는 여백 (px) */
export function sfxMargin(m: SfxMeta): number {
  return Math.ceil(m.size * (m.inner + m.outer + Math.abs(m.shadow)) + m.size * 0.3 + Math.abs(Math.tan((m.skew * Math.PI) / 180)) * m.size * 0.6 + 4);
}

/** 효과음 상자 (원점 기준) — 글자마다 돌린 상자를 다 담고 여백을 더한다 */
export function sfxBounds(m: SfxMeta, glyphs: Glyph[]): Rect {
  if (!glyphs.length) {
    const s = m.size;
    return { x: -s / 2, y: -s / 2, w: s, h: s };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of glyphs) {
    const hw = g.w / 2;
    const hh = g.size * 0.6;
    const a = (g.rot * Math.PI) / 180;
    for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      const px = g.x + dx * Math.cos(a) - dy * Math.sin(a);
      const py = g.y + dx * Math.sin(a) + dy * Math.cos(a);
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  }
  const mg = sfxMargin(m);
  return { x: Math.floor(x0 - mg), y: Math.floor(y0 - mg), w: Math.ceil(x1 - x0 + mg * 2), h: Math.ceil(y1 - y0 + mg * 2) };
}

/** 주 글꼴 이름 — 글꼴 목록의 첫 이름 (따옴표를 벗긴다) */
export const primaryFamily = (stack: string) => (stack.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");

/* ── 문구 모음 (설계 7번) ─────────────────────────────────────── */

export const PHRASE_CATS = ["general", "action", "emotion", "adult"] as const;
export type PhraseCat = (typeof PHRASE_CATS)[number];
