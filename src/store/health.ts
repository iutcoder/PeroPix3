import { create } from "zustand";

/** 백엔드가 알려 주는 앱 상태 — **한 곳에서만 읽는다** (`/api/health`).
 *
 *  ★예전에는 App 의 지역 상태였고 타이틀바 점에만 쓰였다. 같은 값을 보는 자리가 늘면서
 *    (설정의 앱 버전·요청 창구, 생성 푸터의 토큰 검사) 넘겨줄 길이 없어졌다 —
 *    `store/sub.ts` 와 같은 이유로 스토어로 뺀다.
 *  ★**버전을 화면에 박지 않는다.** 타이틀바에 `"3.0"` 이 박혀 있어서 백엔드가 주는 값과
 *    어긋나 있었다 (감사 C5). 정본은 `backend/server.py` 의 `APP_VERSION` 하나다.
 *  ★토큰은 **있는지만** 안다. 값은 서버가 내보내지 않는다.
 */
export type Health = {
  ok: boolean;
  version: string;
  hasToken: boolean;
  /** 버그·건의 창구(디스코드). 백엔드가 정본이다 (`agent.SUPPORT_URL`) */
  support: string;
  /** ★★백엔드가 서 있는 **폴더**. 「지금 붙은 것이 내 백엔드인가」를 가리는 열쇠다
   *  (`lib/sameApp`) — 포터블은 여러 벌을 다른 폴더에 두고 함께 쓴다. */
  root?: string;
  /** 그 백엔드가 듣고 있는 포트 (진단용) */
  port?: number;
  /** ★부팅 때 옛 생성 기록을 옮기는 중인가 (`backend/server.py` 의 `_records_phase`).
   *  `busy` 동안 백엔드는 상태 확인 말고는 전부 막는다. `done`·`total` 은 바이트,
   *  `ws`·`wsTotal` 은 몇 번째 워크스페이스인지, `failed` 는 옮기지 못한 워크스페이스 이름이다. */
  records?: { busy: boolean; done: number; total: number; ws: number; wsTotal: number; failed: string[] };
};

type S = {
  health: Health | null;
  /** 사이드카가 끝내 안 뜬 상태 — 부팅 화면이 이유를 보여 준다 */
  dead: boolean;
  set: (h: Health | null) => void;
  setDead: (v: boolean) => void;
  /** 토큰을 넣거나 지운 직후 — 저장 응답이 준 값으로 바로 맞춘다 */
  setHasToken: (v: boolean) => void;
};

export const useHealth = create<S>((set, get) => ({
  health: null,
  dead: false,
  set: (h) => set({ health: h }),
  setDead: (v) => set({ dead: v }),
  setHasToken: (v) => {
    const h = get().health;
    if (h) set({ health: { ...h, hasToken: v } });
  },
}));

/** 토큰이 있나 — 없으면 NAI 생성이 통째로 안 된다 */
export const useHasToken = () => useHealth((s) => !!s.health?.hasToken);
