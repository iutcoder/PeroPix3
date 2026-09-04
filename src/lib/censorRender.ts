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
import { cloudFromMask, cloudRGBA, cloudReach } from "./steam.ts";

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

const c2d = (w: number, h: number) => {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
};

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
    const expand = s.expand * scale;
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

  /** ── 스팀 ──────────────────────────────────────────────────
   *
   *  ★★**한 덩이로 만든다** (사용자 지시 2026-09-05). 박스마다 따로 그리면 겹친 자리가
   *    밝은 띠로 드러난다 — 캔버스에는 알파를 「최대값」으로 합치는 수단이 없다.
   *    그래서 가릴 자리를 **마스크 한 장**에 모으고, 거기서 잰 거리로 구름 하나를 만든다.
   *    겹치거나 닿은 박스는 한 덩이가 되고, 멀리 떨어진 것은 halo 가 안 닿아 따로 남는다.
   *
   *  ★★**낮은 해상도에서 만들어 늘려 그린다.** 구름은 부드러워서 원본의 1/3 로 만들어도
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

    // 번지는 폭 — **원본 픽셀**로 정하고 화면 배율을 곱한다 (확대해도 구름이 안 변해야 한다).
    // ★박스가 여럿이면 짧은 변의 **평균**으로 정한다. 한 장 안의 박스는 대개 비슷한 크기이고,
    //   폭을 박스마다 달리하면 한 덩이로 합쳐질 때 경계가 드러난다.
    const shorts = live.map((b) => Math.min(b.box[2] - b.box[0], b.box[3] - b.box[1]) + s.expand * 2);
    const reachSrc = cloudReach(shorts.reduce((a, v) => a + v, 0) / shorts.length);
    const reach = reachSrc * scale;

    // 합집합의 자리 — 번지는 폭만큼 넉넉히
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of live) {
      const [bx1, by1, bx2, by2] = b.box;
      const cx = ((bx1 + bx2) / 2) * scale;
      const cy = ((by1 + by2) / 2) * scale;
      const hw = ((bx2 - bx1) / 2 + s.expand) * scale;
      const hh = ((by2 - by1) / 2 + s.expand) * scale;
      // 돌아간 사각형도 감싸도록 두 반폭의 합으로 잡는다 (넉넉한 쪽으로)
      const r = Math.abs(b.rotation ?? 0) > 1e-6 ? Math.hypot(hw, hh) : 0;
      const ex = r || hw;
      const ey = r || hh;
      x0 = Math.min(x0, cx - ex); y0 = Math.min(y0, cy - ey);
      x1 = Math.max(x1, cx + ex); y1 = Math.max(y1, cy + ey);
    }
    const pad = Math.ceil(reach) + 2;
    x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad);
    x1 = Math.ceil(x1 + pad); y1 = Math.ceil(y1 + pad);
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
      // ① 가릴 자리를 한 장에 모은다
      const mcv = c2d(gw, gh);
      const mg = mcv.getContext("2d")!;
      mg.fillStyle = "#fff";
      const sx = gw / W;
      const sy = gh / H;
      for (const b of live) {
        const [bx1, by1, bx2, by2] = b.box;
        const cx = (((bx1 + bx2) / 2) * scale - x0) * sx;
        const cy = (((by1 + by2) / 2) * scale - y0) * sy;
        const w = ((bx2 - bx1) * scale + s.expand * scale * 2) * sx;
        const h = ((by2 - by1) * scale + s.expand * scale * 2) * sy;
        mg.save();
        mg.translate(cx, cy);
        if (b.rotation) mg.rotate(b.rotation);
        mg.fillRect(-w / 2, -h / 2, w, h);
        mg.restore();
      }
      const px = mg.getImageData(0, 0, gw, gh).data;
      const mask = new Uint8Array(gw * gh);
      for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;

      // ② 거리에서 구름 하나
      const cloud = cloudFromMask(mask, gw, gh, {
        // ★씨앗은 **맨 앞 박스**의 것을 쓴다 — 박스마다 다른 씨앗을 섞을 수 없다 (한 덩이라서).
        seed: live[0].seed,
        feather: s.feather,
        reach: reach * ((sx + sy) / 2),
      });
      const cv = c2d(gw, gh);
      const g = cv.getContext("2d")!;
      const img = g.createImageData(gw, gh);
      img.data.set(cloudRGBA(cloud, s.steamBright, s.steamAlpha));
      g.putImageData(img, 0, 0);
      baked = { key, cv, x: x0, y: y0, w: W, h: H };
      this.steamCache = baked;
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


