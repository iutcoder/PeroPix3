/** 가리기를 **화면에서 그린다** — 캔버스 합성기.
 *
 *  ★★사용자 결정 2026-08-23: 가리는 일을 서버에서 화면으로 옮긴다. 그전에는 박스를 1px 만
 *    움직여도 서버가 그림 전체를 다시 그려 보냈다 (실측: 스팀 219ms + PNG 인코딩 58ms).
 *    사람 손이 움직이는 속도에는 원리상 못 따라온다.
 *  ★★렌더러는 **이것 하나뿐이다.** 저장도 이 함수가 원본 크기로 그린 것을 올린다
 *    (`renderFull`). v2 는 화면과 서버에 한 벌씩 두어 미리보기와 저장본이 갈렸는데,
 *    그 사고는 「두 벌」에서 온 것이지 「화면에서 그린다」에서 온 것이 아니다.
 *
 *  구조 — **재료와 모양을 가른다.** 여기가 빠른 까닭이다:
 *
 *      재료  방식·설정에만 매인다. 그림 전체를 덮은 한 장을 만들어 **캐시**한다
 *            (모자이크·흐리기·단색). 스팀은 박스 비율별 무늬 판을 캐시한다.
 *      모양  박스의 자리·크기·회전·넓히기·부드럽게. **매 프레임** 다시 그린다.
 *
 *  박스를 끄는 동안 일어나는 일은 `drawImage` 몇 번과 경로 채우기 하나뿐이다.
 */
import { bucketAspect, bucketScale, cloudScale, plate, plateRGBA, spanOf } from "./steam.ts";
import { makeNoise } from "./noise.ts";
import type { Plate } from "./steam.ts";

export type CoverSettings = {
  method: string;
  color: string;
  expand: number;
  feather: number;
  mosaic: number;
  mosaicOpacity: number;
  blur: number;
  steamBright: number;
  steamAlpha: number;
};

export type RenderBox = {
  /** ★**안정된 씨앗**이다. 박스를 옮겨도 구름이 안 바뀌게 하려고 좌표가 아니라 이것을 쓴다
   *  (사용자 결정 2026-08-23). 옛것은 씨앗을 `x1*1000+y1` 로 만들어, 1px 만 밀어도
   *  구름이 통째로 다른 모양이 됐다. */
  seed: number;
  box: [number, number, number, number];
  rotation?: number;
  /** 박스마다 다른 방식 (없으면 전체 설정) */
  method?: string;
};

type Src = CanvasImageSource & { width: number; height: number };

/** 구름을 만드는 작업 해상도 (긴 변). ★★**여기가 비용이다** — 픽셀마다 노이즈를 여섯 번
 *  돈다 (실측 2026-09-05: 420px 에 40ms · 300px 에 21ms). 구름은 부드러워서 줄여 만들어
 *  늘려도 눈에 차이가 없다. */
const STEAM_WORK = 340;
/** ★★**끄는 동안**의 해상도. 손을 떼면 위 값으로 한 번 더 굽는다 — 이 앱이 한 번 겪은
 *  문제라(2026-08-23 「반응성이 매우 안 좋음」) 매 프레임 40ms 를 태울 수 없다. */
const STEAM_WORK_QUICK = 170;

/** 두 구름을 합칠 때 **이만큼 차이 안에서만** 이음매를 둥글린다 (0..255 의 덮임 단위) */
const SMAX = 40;

const c2d = (w: number, h: number) => {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
};

/** 덮임 값(0..255, `stride` 간격)을 **반지름 `r` 의 정사각 창 최소값**으로 — 침식.
 *
 *  ★★음수 「범위」(사용자 지시 2026-09-05: *"넓히기를 음수도 가능하게"*)는 **합집합을** 깎는다.
 *    사각형마다 깎으면 겹쳐 덮은 사각형(`rectsOf`)이 만나는 자리마다 양쪽이 물러나 **덩어리
 *    안쪽에 틈**이 생긴다. 그래서 양수는 v2 대로 사각형마다 넓히고, 음수는 다 모은 뒤 한 번 깎는다.
 *  가로·세로 두 번의 1차원 최소값이라 반지름과 무관하게 픽셀당 상수 비용이다 (van Herk). */
export function erodeAlpha(a: Uint8Array | Uint8ClampedArray, W: number, H: number, r: number, stride = 1, offset = 0) {
  const R = Math.round(r);
  if (R <= 0) return;
  const k = 2 * R + 1;
  const n = Math.max(W, H);
  const tmp = new Uint8Array(n + 2 * R), f = new Uint8Array(n + 2 * R), b = new Uint8Array(n + 2 * R);
  const pass = (len: number, get: (i: number) => number, put: (i: number, v: number) => void) => {
    // 양 끝은 밖을 「0」으로 본다 — 그림 끝에서도 깎인다 (덮개가 끝에 붙어 있으면 그만큼 물러난다)
    const m = len + 2 * R;
    tmp.fill(0, 0, m);
    for (let i = 0; i < len; i++) tmp[R + i] = get(i);
    for (let i = 0; i < m; i++) f[i] = i % k === 0 ? tmp[i] : Math.min(f[i - 1], tmp[i]);
    for (let i = m - 1; i >= 0; i--) b[i] = (i % k === k - 1 || i === m - 1) ? tmp[i] : Math.min(b[i + 1], tmp[i]);
    for (let i = 0; i < len; i++) put(i, Math.min(b[i], f[i + k - 1]));
  };
  for (let y = 0; y < H; y++) {
    const row = y * W;
    pass(W, (x) => a[(row + x) * stride + offset], (x, v) => { a[(row + x) * stride + offset] = v; });
  }
  for (let x = 0; x < W; x++) {
    pass(H, (y) => a[(y * W + x) * stride + offset], (y, v) => { a[(y * W + x) * stride + offset] = v; });
  }
}

/** 박스별 v2 무늬 판 — 씨앗·부드럽게·비율·배율·해상도에만 매인다. ★그림과 무관하므로 **렌더러가
 *  아니라 모듈**이 든다 — 그림을 넘겨 렌더러가 새로 생겨도 판은 그대로 쓴다. 개수만 막는다. */
const plates = new Map<string, Plate>();
const PLATES_MAX = 256;

/** 그림 한 장에 딸린 렌더러. 재료 캐시를 들고 있으므로 **그림마다 하나** 만든다. */
export class CensorRenderer {
  private src: Src;
  /** 원본 픽셀 크기 */
  readonly w: number;
  readonly h: number;

  /** 재료 — 그림 전체를 덮은 한 장. 열쇠는 `방식|수치|그릴 크기` */
  private layers = new Map<string, HTMLCanvasElement>();
  /** 구운 구름 한 장 — 열쇠는 **모양과 설정**이다 (`steamKey`) */
  private steamCache: { key: string; cv: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null = null;
  /** 매 프레임 새로 만들지 않으려고 들고 있는 석 장 (모양 · 여백을 두른 모양 · 오려낸 재료) */
  private maskCv: HTMLCanvasElement | null = null;
  private padCv: HTMLCanvasElement | null = null;
  private cutCv: HTMLCanvasElement | null = null;

  constructor(src: Src, w?: number, h?: number) {
    this.src = src;
    this.w = w ?? src.width;
    this.h = h ?? src.height;
  }

  /** 설정이 바뀌면 재료를 버린다. ★모양만 바뀔 때는 **부르지 않는다** — 그게 빠른 이유다 */
  invalidate() {
    this.layers.clear();
    this.steamCache = null;
  }

  /** 무늬까지 버린다 (「부드럽게」가 바뀌었을 때) */
  invalidateAll() {
    this.invalidate();
  }

  /** 한 장을 그린다. `scale` 은 **원본 픽셀당 화면 픽셀**.
   *
   *  ★`withBase` 가 거짓이면 **덮개만** 그린다 (바탕은 투명). 화면에서는 원본을 `<img>` 로
   *    이미 깔아 두었으므로 그 위에 덮개만 얹으면 되고, 매 프레임 원본을 다시 그리지 않아도
   *    된다. 「들춰보기」도 이 캔버스의 CSS 투명도 하나로 끝난다.
   *  ★저장할 때만 참이다 — 그때는 한 장으로 합쳐야 한다. */
  draw(
    target: HTMLCanvasElement, boxes: RenderBox[], s: CoverSettings,
    scale: number, withBase = false, quick = false,
  ) {
    const W = Math.max(1, Math.round(this.w * scale));
    const H = Math.max(1, Math.round(this.h * scale));
    if (target.width !== W || target.height !== H) {
      target.width = W;
      target.height = H;
      // 크기가 바뀌면 재료도 그 크기로 다시 만들어야 한다
      this.invalidate();
    }
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (withBase) ctx.drawImage(this.src, 0, 0, W, H);
    if (!boxes.length) return;

    // ★방식이 섞여 있어도 **한 방식당 한 번**만 오려 붙인다 (박스마다 오리면 그만큼 느려진다)
    const groups = new Map<string, RenderBox[]>();
    for (const b of boxes) {
      const how = b.method || s.method;
      const at = groups.get(how);
      if (at) at.push(b);
      else groups.set(how, [b]);
    }

    for (const [how, list] of groups) {
      if (how === "steam") this.drawSteam(ctx, list, s, scale, quick);
      else this.drawMasked(ctx, how, list, s, scale, W, H);
    }
  }

  // ── 재료 ──────────────────────────────────────────────────

  private layer(how: string, s: CoverSettings, scale: number, W: number, H: number) {
    const key = `${how}|${s.mosaic}|${s.blur}|${s.color}|${W}x${H}`;
    const hit = this.layers.get(key);
    if (hit) return hit;
    const cv = c2d(W, H);
    const g = cv.getContext("2d")!;
    if (how === "mosaic") {
      // ★★격자를 **그림 기준**으로 맞춘다 (사용자 결정 2026-08-23). 옛것은 잘라낸 조각마다
      //   따로 줄여서, 박스를 옮기면 무늬가 미끄러졌다. 그림째 줄이면 제자리에 선다.
      const block = Math.max(1, s.mosaic * scale);
      const sw = Math.max(1, Math.round(W / block));
      const sh = Math.max(1, Math.round(H / block));
      const small = c2d(sw, sh);
      const sg = small.getContext("2d")!;
      sg.imageSmoothingEnabled = true;
      sg.drawImage(this.src, 0, 0, sw, sh);
      g.imageSmoothingEnabled = false;
      g.drawImage(small, 0, 0, W, H);
      g.imageSmoothingEnabled = true;
    } else if (how === "blur") {
      g.filter = `blur(${Math.max(1, s.blur * scale)}px)`;
      g.drawImage(this.src, 0, 0, W, H);
      g.filter = "none";
      // ★가장자리가 비쳐 어두워지는 것을 막는다. 흐리기는 판 밖을 투명으로 보므로,
      //   그 자리에 **원본을 깔아** 메운다 (박스가 그림 끝에 붙었을 때만 보이던 결함)
      g.globalCompositeOperation = "destination-over";
      g.drawImage(this.src, 0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    } else {
      g.fillStyle = how === "white" ? "#ffffff" : how === "color" ? s.color : "#000000";
      g.fillRect(0, 0, W, H);
    }
    this.layers.set(key, cv);
    return cv;
  }

  // ── 모양 ──────────────────────────────────────────────────

  /** 박스 하나의 사각형을 지금 좌표계에 그린다 (넓히기·회전 포함) */
  private path(g: CanvasRenderingContext2D, b: RenderBox, expand: number, scale: number) {
    const [x1, y1, x2, y2] = b.box;
    const cx = ((x1 + x2) / 2) * scale;
    const cy = ((y1 + y2) / 2) * scale;
    const w = (x2 - x1) * scale + expand * 2;
    const h = (y2 - y1) * scale + expand * 2;
    g.save();
    g.translate(cx, cy);
    if (b.rotation) g.rotate(b.rotation);
    g.beginPath();
    g.rect(-w / 2, -h / 2, w, h);
    g.restore();
  }

  private drawMasked(
    ctx: CanvasRenderingContext2D, how: string, list: RenderBox[],
    s: CoverSettings, scale: number, W: number, H: number,
  ) {
    // ★「범위」— 양수는 사각형마다 넓히고(v2), 음수는 마스크를 다 그린 뒤 합집합을 깎는다 (`erodeAlpha`)
    const expand = Math.max(0, s.expand) * scale;
    const shrink = Math.max(0, -s.expand) * scale;
    const feather = s.feather * scale;
    /* ★★그림 가장자리에 붙은 박스가 **끝에서 옅어지던 결함** (유저 제보 2026-09-02: 흰색 검열이
       좌·우·상단 가장자리에서 제대로 안 됨). 캔버스 `blur` 필터는 캔버스 **밖을 투명**으로
       보므로, 마스크를 그림 크기 그대로 흐리면 그림 끝에서 feather 폭만큼 마스크가 빠지고
       그 자리의 덮개가 반투명이 된다 (실측: feather 10 에서 끝 픽셀의 원본 비침 46%).
       흰색만이 아니라 검정·색 지정·모자이크·흐리기가 전부 같은 마스크를 지난다.
       그래서 **여백(`m`)을 두른 판**에 마스크를 놓고, 그림 가장자리 픽셀을 여백으로 늘려
       깐 뒤(가장자리 복제 = 밖을 「끝과 같은 값」으로 본다) 흐린다. 그림 안쪽에서 끝나는
       변의 부드러움은 그대로다. 여백은 blur 반경(σ = feather/2)의 4배로, 그 밖의 투명이
       끝에 미치는 몫은 0.1% 미만이다. */
    const m = feather > 0 ? Math.ceil(feather * 2) : 0;
    const PW = W + m * 2;
    const PH = H + m * 2;
    if (!this.maskCv || this.maskCv.width !== W || this.maskCv.height !== H
        || !this.padCv || this.padCv.width !== PW || this.padCv.height !== PH) {
      this.maskCv = c2d(W, H);
      this.padCv = c2d(PW, PH);
      this.cutCv = c2d(PW, PH);
    }
    const mask = this.maskCv;
    const mg = mask.getContext("2d")!;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, W, H);

    /* ★★안쪽은 100% 로 남기고 **가장자리만** 부드럽게 한다. 그래서 흐리기 전에 테두리를
       `feather` 만큼 **넓힌다** (파이썬의 MaxFilter → GaussianBlur 과 같은 차례다).
       바로 흐리면 박스 안쪽까지 옅어져, 가려야 할 것이 비친다. */
    mg.fillStyle = "#fff";
    mg.strokeStyle = "#fff";
    mg.lineJoin = "round";
    mg.lineWidth = Math.max(0, feather);
    for (const b of list) {
      this.path(mg, b, expand, scale);
      mg.fill();
      if (feather > 0) mg.stroke();
    }
    if (shrink >= 0.5) {
      const img = mg.getImageData(0, 0, W, H);
      erodeAlpha(img.data, W, H, shrink, 4, 3);
      mg.putImageData(img, 0, 0);
    }

    // 여백을 두른 판 — 가운데에 마스크, 둘레에는 가장자리 한 줄을 늘려 깐다
    const pad = this.padCv!;
    const pg = pad.getContext("2d")!;
    pg.setTransform(1, 0, 0, 1, 0, 0);
    pg.clearRect(0, 0, PW, PH);
    pg.imageSmoothingEnabled = false;
    pg.drawImage(mask, m, m);
    if (m > 0) {
      pg.drawImage(mask, 0, 0, 1, H, 0, m, m, H);                 // 왼쪽 띠
      pg.drawImage(mask, W - 1, 0, 1, H, m + W, m, m, H);         // 오른쪽 띠
      pg.drawImage(mask, 0, 0, W, 1, m, 0, W, m);                 // 위 띠
      pg.drawImage(mask, 0, H - 1, W, 1, m, m + H, W, m);         // 아래 띠
      pg.drawImage(mask, 0, 0, 1, 1, 0, 0, m, m);                 // 네 모서리
      pg.drawImage(mask, W - 1, 0, 1, 1, m + W, 0, m, m);
      pg.drawImage(mask, 0, H - 1, 1, 1, 0, m + H, m, m);
      pg.drawImage(mask, W - 1, H - 1, 1, 1, m + W, m + H, m, m);
    }
    pg.imageSmoothingEnabled = true;

    const cut = this.cutCv!;
    const cg = cut.getContext("2d")!;
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, PW, PH);
    cg.filter = feather > 0 ? `blur(${feather / 2}px)` : "none";
    cg.drawImage(pad, 0, 0);
    cg.filter = "none";
    // 마스크가 남긴 자리에만 재료를 남긴다 (재료는 그림 자리에만 — 여백은 어차피 잘려 나간다)
    cg.globalCompositeOperation = "source-in";
    cg.drawImage(this.layer(how, s, scale, W, H), m, m);
    cg.globalCompositeOperation = "source-over";

    // ★모자이크의 「진하기」는 재료를 옅게 얹는 것이다 (파이썬도 마스크에 곱했다)
    ctx.globalAlpha = how === "mosaic"
      ? Math.min(1, Math.max(0, s.mosaicOpacity / 100)) : 1;
    ctx.drawImage(cut, -m, -m);
    ctx.globalAlpha = 1;
  }

  /** 이 구름이 무엇으로 만들어졌나 — 모양이 바뀌면 다시 굽는다 */
  private steamKey(list: RenderBox[], s: CoverSettings, scale: number, quick: boolean) {
    const boxes = list
      .map((b) => `${b.seed}:${b.box.map((v) => Math.round(v)).join(",")}:${(b.rotation ?? 0).toFixed(3)}`)
      .join("|");
    return `${boxes}|${s.expand}|${s.feather}|${s.steamBright}|${s.steamAlpha}|${scale.toFixed(3)}|${quick ? "q" : "f"}`;
  }

  /** 박스 하나가 쓸 **v2 무늬 판**. 씨앗·부드럽게·비율·배율에만 매이므로 캐시가 잘 듣는다 */
  /** 박스의 구름 배율 (5% 버킷). ★**원본 픽셀의 짧은 변**으로 정한다 (화면 배율이 아니라) — 확대해도 구름이 안 변한다 */
  private steamScale(b: RenderBox, s: CoverSettings) {
    const [x1, y1, x2, y2] = b.box;
    return bucketScale(cloudScale(Math.min(x2 - x1, y2 - y1) + Math.max(0, s.expand) * 2));
  }

  private steamPlate(b: RenderBox, s: CoverSettings, scale: number): Plate {
    const [x1, y1, x2, y2] = b.box;
    const w = (x2 - x1 + Math.max(0, s.expand) * 2) * scale;
    const h = (y2 - y1 + Math.max(0, s.expand) * 2) * scale;
    const k = this.steamScale(b, s);
    /* ★★판 해상도는 **그려질 크기**에 맞춘다 (사용자 지적 2026-09-05: *"브러시처럼 쭉 그으면
       앱이 정지된 수준"*). 붓 조각은 화면에서 수십 px 로 그려지는데 640px 판을 40ms 씩 굽고
       있었다 — 획이 박스에 닿으면 조각이 수십 개라 프레임당 초 단위였다. 두 단으로 뭉갠다 (128 · 256).
       ★★열쇠는 **획과 무관해야 한다** (사용자 제보 2026-09-05: *"손을 떼서 확정되는 순간 0.5초
         멈춤"*, 계측: 손을 뗀 굽기의 판 207ms·125ms, 나머지는 30ms). 전에는 작업 격자에서의
         크기(구름 전체 경계 상자에 따라 변하는 k 를 곱한 것)로 골라서, 획을 그을 때마다 상자가
         변해 **같은 조각의 판이 다른 해상도로 다시 구워졌다.** 그래서 화면 크기만 본다.
       ★640 은 없앴다 — 구름은 작업 격자(긴 변 340)에만 그려지므로 256 을 1.3배 늘려 읽어도
         노이즈 파장(15px 이상)이 다 살고, 640 판 하나는 브라우저에서 40ms 다. */
    const need = Math.max(w, h) * spanOf(k);
    const res = need <= 100 ? 128 : 256;
    const key = `${b.seed}|${s.feather}|${bucketAspect(w, h)}|${k}|${res}`;
    let p = plates.get(key);
    if (!p) {
      p = plate({ seed: b.seed, feather: s.feather, aspect: bucketAspect(w, h), scale: k, res });
      if (plates.size >= PLATES_MAX) plates.delete(plates.keys().next().value!);
      plates.set(key, p);
    }
    return p;
  }

  /** ── 스팀 ──────────────────────────────────────────────────
   *
   *  ★★★**그림은 v2 그대로, 합치는 방법만 바꾼다** (사용자 지시 2026-09-05:
   *    *"보기에 v2 버전하고 똑같아 보이면서 확장 가능한게 아니면 의미가 없음"*).
   *    한때 가릴 자리 전체에서 **거리를 재어** 구름을 새로 만들었는데, 겹침은 해결됐지만
   *    *"아예 시각적인 느낌이 너무 다름"* 이었다 — v2 의 거리는 **박스 크기로 정규화된 타원
   *    거리**라 노이즈 진폭 0.25 가 「반지름의 25%」인데, 픽셀 거리로 재면 그 비례가 사라진다.
   *
   *  그래서 순서가 이렇다:
   *    ① 박스마다 **v2 판을 그대로** 만든다 (`steamPlate` → `plate`).
   *    ② 판들을 캔버스가 아니라 **배열에 모은다** — 픽셀마다 더 진한 쪽을 남긴다(max).
   *       캔버스에 겹쳐 그리면 알파가 더해져 겹친 자리가 밝은 띠가 되기 때문이다.
   *    ③ 모은 것에 밝기·진하기를 입혀 한 장으로 그린다.
   *  겹치거나 닿은 박스는 구름이 이어져 한 덩이가 되고, 떨어진 것은 그대로 따로 남는다.
   *
   *  ★★**낮은 해상도에서 모아 늘려 그린다.** 구름은 부드러워서 원본의 1/3 로 만들어도
   *    눈에 차이가 없고, 박스를 끄는 동안 매 프레임 다시 만들 수 있어야 한다 (이 앱이 한 번
   *    겪은 문제다 — 2026-08-23 「반응성이 매우 안 좋음」).
   *  ★모양이 안 바뀌면 구운 것을 그대로 쓴다 (`steamCache`).
   */
  private drawSteam(
    ctx: CanvasRenderingContext2D, list: RenderBox[], s: CoverSettings, scale: number,
    quick = false,
  ) {
    const live = list.filter((b) => b.box[2] > b.box[0] && b.box[3] > b.box[1]);
    if (!live.length) return;

    /** 박스 하나가 화면에서 차지하는 자리 — 두 번 쓰므로 미리 뽑는다. 판은 작업 해상도가 정해진 뒤에 */
    const items = live.map((b) => {
      const [x1, y1, x2, y2] = b.box;
      return {
        b,
        cx: ((x1 + x2) / 2) * scale,
        cy: ((y1 + y2) / 2) * scale,
        // ★음수 「범위」는 여기서 안 쓴다 — 다 모은 덮임을 깎는다 (아래 `erodeAlpha`)
        w: (x2 - x1 + Math.max(0, s.expand) * 2) * scale,
        h: (y2 - y1 + Math.max(0, s.expand) * 2) * scale,
        rot: b.rotation ?? 0,
        span: spanOf(this.steamScale(b, s)),
      };
    });

    // 구름들이 차지하는 자리 — 판은 박스의 `span` 배로 그려진다
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      const hw = (it.w * it.span) / 2;
      const hh = (it.h * it.span) / 2;
      const r = Math.abs(it.rot) > 1e-6 ? Math.hypot(hw, hh) : 0;
      x0 = Math.min(x0, it.cx - (r || hw)); y0 = Math.min(y0, it.cy - (r || hh));
      x1 = Math.max(x1, it.cx + (r || hw)); y1 = Math.max(y1, it.cy + (r || hh));
    }
    x0 = Math.floor(x0 - 1); y0 = Math.floor(y0 - 1);
    x1 = Math.ceil(x1 + 1); y1 = Math.ceil(y1 + 1);
    const W = Math.max(1, x1 - x0);
    const H = Math.max(1, y1 - y0);

    // 작업 해상도 — 긴 변을 이만큼으로 줄인다
    const long = Math.max(W, H);
    const k = Math.min(1, (quick ? STEAM_WORK_QUICK : STEAM_WORK) / long);
    const gw = Math.max(8, Math.round(W * k));
    const gh = Math.max(8, Math.round(H * k));
    const key = this.steamKey(live, s, scale, quick);

    let baked = this.steamCache && this.steamCache.key === key ? this.steamCache : null;
    if (!baked) {
      // 계측 — 제 해상도(손을 뗀 뒤) 굽기만 콘솔에 남긴다 (사용자 제보 2026-09-05: 그 순간 0.5초 멈춤)
      const tm = quick ? null : { t: performance.now(), plates: 0, lum: 0, acc: 0, rgba: 0, newPlates: 0 };
      const lap = () => { const n = performance.now(); const d = n - tm!.t; tm!.t = n; return d; };
      const platesBefore = plates.size;
      const sx = gw / W, sy = gh / H;
      const cover = new Uint8Array(gw * gh);

      /* ★★**밝기 무늬는 격자 전체에서 한 번 만든다** (판마다가 아니라).
         판의 것을 쓰면 두 구름이 만나는 자리에서 무늬가 갈려 **각진 선**이 드러난다
         (2026-09-05 렌더 대조). v2 의 밝기는 230~255 의 좁은 흔들림이라, 어느 좌표에서
         만들든 구름의 성격은 같다 — 갈리지 않는 쪽이 낫다.
         ★계산은 v2 원문 그대로다 (3옥타브 · 0.5~1 로 압축). 파장만 격자 단위로 환산한다. */
      const lum = new Uint8Array(gw * gh);
      {
        const n = makeNoise(live[0].seed);
        const ff = 1 + Math.min(50, Math.max(0, s.feather)) / 25;
        const ns = (Math.max(gw, gh) / 2) * ff;
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            const bn = n(x / ns, y / ns) + n((x / ns) * 2, (y / ns) * 2) * 0.5
              + n((x / ns) * 4, (y / ns) * 4) * 0.25;
            lum[y * gw + x] = Math.round((0.5 + ((bn / 1.75 + 1) / 2) * 0.5) * 255);
          }
        }
      }
      if (tm) tm.lum = lap();

      for (const it of items) {
        if (tm) tm.acc += lap();
        const p = this.steamPlate(it.b, s, scale);
        if (tm) tm.plates += lap();
        // 이 판이 격자에서 차지하는 크기·자리
        const dw = it.w * p.span * sx, dh = it.h * p.span * sy;
        const cx = (it.cx - x0) * sx, cy = (it.cy - y0) * sy;
        // 격자 → 판 좌표는 **회전의 역**이다
        const cos = Math.cos(-it.rot), sin = Math.sin(-it.rot);
        const rad = Math.hypot(dw, dh) / 2;
        const gx0 = Math.max(0, Math.floor(cx - rad)), gx1 = Math.min(gw - 1, Math.ceil(cx + rad));
        const gy0 = Math.max(0, Math.floor(cy - rad)), gy1 = Math.min(gh - 1, Math.ceil(cy + rad));

        for (let y = gy0; y <= gy1; y++) {
          for (let x = gx0; x <= gx1; x++) {
            const ux = x + 0.5 - cx, uy = y + 0.5 - cy;
            const rx = ux * cos - uy * sin, ry = ux * sin + uy * cos;
            // 판 픽셀 자리 (가장자리 반 픽셀을 빼고 잡는다)
            const fx = (rx / dw + 0.5) * p.pw - 0.5;
            const fy = (ry / dh + 0.5) * p.ph - 0.5;
            if (fx < 0 || fy < 0 || fx > p.pw - 1 || fy > p.ph - 1) continue;
            // 이중선형 — 판을 늘려 쓰므로 최근접이면 계단이 진다
            const ix = Math.floor(fx), iy = Math.floor(fy);
            const tx = fx - ix, ty = fy - iy;
            const jx = Math.min(p.pw - 1, ix + 1), jy = Math.min(p.ph - 1, iy + 1);
            const cv = (p.cover[iy * p.pw + ix] * (1 - tx) + p.cover[iy * p.pw + jx] * tx) * (1 - ty)
              + (p.cover[jy * p.pw + ix] * (1 - tx) + p.cover[jy * p.pw + jx] * tx) * ty;
            if (cv <= 0) continue;
            const i = y * gw + x;
            const was = cover[i];
            /* ★★**더 진한 쪽을 남긴다** — 더하면 겹친 자리가 밝은 띠가 된다.
               ★그냥 최대값만 쓰면 두 구름이 만나는 선이 각지게 드러나므로, 두 값이 엇비슷한
                 자리에서만 조금 부풀려 둥글린다 — 많아야 `SMAX/4`(≈10/255)라 밝아 보이지 않는다.
               ★안 닿았던 자리(was 0)는 그대로 넣는다 (안 그러면 배경이 옅게 덮인다) */
            const hi = cv > was ? cv : was;
            if (was > 0) {
              const t = Math.max(0, (SMAX - Math.abs(cv - was)) / SMAX);
              cover[i] = Math.min(255, Math.round(hi + t * t * SMAX * 0.25));
            } else cover[i] = Math.round(hi);
          }
        }
      }

      if (tm) tm.acc += lap();
      // ★음수 「범위」— 모은 덮임을 격자 단위로 깎는다 (화면 px → 격자 px 는 k)
      if (s.expand < 0) erodeAlpha(cover, gw, gh, -s.expand * scale * k);

      const cv = c2d(gw, gh);
      const g = cv.getContext("2d")!;
      const img = g.createImageData(gw, gh);
      img.data.set(plateRGBA({ cover, lum }, s.steamBright, s.steamAlpha));
      g.putImageData(img, 0, 0);
      baked = { key, cv, x: x0, y: y0, w: W, h: H };
      this.steamCache = baked;
      if (tm) {
        tm.rgba = lap();
        console.debug(`[censor] 스팀 제 해상도 굽기: 조각 ${items.length}, 격자 ${gw}×${gh}, 무늬 ${tm.lum.toFixed(0)}ms, 판 ${tm.plates.toFixed(0)}ms (새 판 ${plates.size - platesBefore}), 누적 ${tm.acc.toFixed(0)}ms, 색 입히기 ${tm.rgba.toFixed(0)}ms`);
      }
    }
    ctx.drawImage(baked.cv, baked.x, baked.y, baked.w, baked.h);
  }

  /** 저장용 — **원본 크기**로 한 장 굽는다. 화면에 쓰는 것과 같은 `draw` 를 지난다 */
  async renderFull(boxes: RenderBox[], s: CoverSettings, type = "image/png"): Promise<Blob> {
    const cv = c2d(this.w, this.h);
    // ★저장은 화면 캐시와 섞이지 않게 제 렌더러로 돈다 (그릴 크기가 다르면 재료도 다르다)
    const one = new CensorRenderer(this.src, this.w, this.h);
    /* ★캐시를 물려주지 않는다 — 구름은 **그릴 크기에 매인 한 장**이라 화면용(축소)과
       저장용(원본 크기)이 다르다. 저장은 한 번뿐이라 다시 굽는 비용이 문제되지 않는다. */
    one.draw(cv, boxes, s, 1, true);
    return await new Promise<Blob>((ok, no) =>
      cv.toBlob((b) => (b ? ok(b) : no(new Error("캔버스를 굽지 못했습니다"))), type));
  }
}


