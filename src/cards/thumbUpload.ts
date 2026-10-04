import { api } from "../lib/backend";
import type { AnyCard, CardKind } from "../store/cards";
import type { View } from "../store/prompt";
import { previewOf } from "../store/previews";

/** 그림을 **꽂는** 창구 — 배너든 카드 앞면이든 덱 커버든 여기를 지난다.
 *
 *  ★바이트를 주고받지 않는다 (2026-08-02 개편). 어느 생성물인지만 알려 주면 서버가
 *    원본에서 굽고 `tid` 를 돌려준다. 셋이 같은 그림을 쓰면 파일도 하나다.
 *
 *  ★예전 구조(브라우저가 캔버스로 줄여 base64 로 업로드)를 되살리지 말 것 —
 *    같은 주소를 평범한 <img> 로 먼저 띄운 적이 있으면 CORS 헤더 없는 캐시 항목이
 *    재사용돼 로드가 실패하고, 업로드가 **조용히 아무 일도 안 하고 끝났다**
 *    (실사용: "적용을 눌러도 반응이 없다"). 서버가 파일에서 직접 구우면 그 경로가 없다.
 */

/** 생성물을 고정 썸네일로 굳힌다 → tid. 실패하면 null (콘솔에 남는다). */
export async function pinImage(ws: string, file: string): Promise<string | null> {
  try {
    // ★미저장 그림은 파일이 없으니 **바이트를 싣는다** (사용자 지시 2026-09-30: 저장하지 않고 되는 기능은 다 켠다)
    const pv = previewOf(file);
    const r = await api<{ tid: string }>("/api/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pv ? { workspace: ws, data: pv.preview.b64 } : { workspace: ws, file }),
    });
    return r.tid;
  } catch (e) {
    // ★삼키지 않는다 — 조용한 실패가 바로 그 결함이었다
    console.error("[thumb] 썸네일을 만들지 못했습니다:", ws, file, e);
    return null;
  }
}

/** 카드 앞면에 건다 (보는 방식은 배너용·앞면용이 따로) */
export async function setCardThumb(
  kind: CardKind,
  cardId: string,
  tid: string,
  view: { banner: View; face: View },
): Promise<AnyCard | null> {
  try {
    const r = await api<{ card: AnyCard }>(`/api/cards/thumb/${kind}/${cardId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tid, view }),
    });
    return r.card;
  } catch (e) {
    console.error("[thumb] 카드에 그림을 걸지 못했습니다:", kind, cardId, e);
    return null;
  }
}
