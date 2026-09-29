import { create } from "zustand";

/** 지금 보고 있는 씬과 장 — ★**프리뷰와 씬 칸이 서로 다른 컴포넌트**라 둘이 함께 보는 값을
 *  컴포넌트 상태로는 들 수 없다 (`slotSel` 이 같은 이유로 생겼다).
 *
 *  저장하지 않는다 — 이 화면을 보는 동안만 사는 값이다.
 *  ★★**탭마다 따로 기억한다** (사용자 지시 2026-08-22). 예전에는 탭을 옮기면 비웠는데,
 *    돌아왔을 때 보던 장을 다시 찾아 눌러야 했다. 이제 떠날 때 그 탭 몫으로 담아 두고
 *    돌아오면 그대로 되살린다 (`switchTab`).
 */
type Spot = {
  /** 고른 씬의 id (없으면 "") */
  cell: string;
  /** 고른 장의 파일 (없으면 null — 프리뷰는 안내만 띄운다) */
  file: string | null;
  /** ★**아직 만들어지는 중인 칸**을 골랐다 (큐 항목 id). 그때 `file` 은 null 이고
   *  프리뷰는 **빈 화면**이다 — 파일이 없으니 할 수 있는 일도 없다 (`SceneActions` 가 빠진다). */
  pending: string | null;
};

type S = Spot & {
  /** 탭 id → 그 탭에서 마지막으로 보던 자리 */
  memo: Record<string, Spot>;
  /** ★★**손으로 여러 장 고른 것** (`Ctrl`·`Shift` 클릭). 씬 줄의 컴포넌트 상태였는데,
   *  큰 그림 아래 **삭제 단추**도 이것을 봐야 해서 여기로 올렸다 (사용자 지시 2026-08-22:
   *  *"다중 선택 상태에서 이미지 삭제버튼 누르면 전부 삭제"*). 두 컴포넌트가 형제라
   *  한쪽 상태로는 다른 쪽이 못 본다 (이 스토어가 생긴 것과 같은 사정이다).
   *  ★★**이 목록이 곧 정본**이다. 예전에는 여기에 「지금 보는 장」을 **쓸 때 더하는**
   *    파생 규칙이 있었는데, 고른 장이 큰 자리로 올라오게 되면서 뜻이 어긋났다 —
   *    토글로 뺀 장이 「지금 보는 장」이라 도로 들어왔다. 더하는 것은 **담을 때 한 번**
   *    한다 (`SceneLane` 의 `pick`). */
  picked: string[];
  setPicked: (files: string[]) => void;
  focus: (cell: string, file: string | null) => void;
  /** 만들어지는 중인 칸을 고른다 */
  focusPending: (cell: string, id: string) => void;
  clear: () => void;
  /** 탭을 옮긴다 — 떠나는 탭 것을 담고, 가는 탭 것을 되살린다 */
  switchTab: (from: string | undefined, to: string | undefined) => void;
  /** 그림이 다른 폴더로 옮겨졌다 — 보던 장·고른 장·탭마다 담아 둔 장의 경로를 새것으로 */
  remap: (moves: Record<string, string>) => void;
};

const EMPTY: Spot = { cell: "", file: null, pending: null };

export const useSceneFocus = create<S>((set) => ({
  ...EMPTY,
  memo: {},
  picked: [],
  setPicked: (files) => set({ picked: files }),
  /* ★★**`focus` 는 고른 것을 풀지 않는다** (2026-08-22, 한 번 그렇게 만들었다가 되돌렸다).
     여기 넣으면 **Ctrl·Shift 클릭에서도 풀려 여러 장 고르기가 아예 안 된다** —
     씬 줄(`[data-scene]`)이 **click** 으로 `onFocus` 를 부르는데, 칸의 `stopPropagation` 은
     **pointerdown** 만 막아서 그 click 이 수식키와 상관없이 뒤이어 올라오기 때문이다.
     ★푸는 것은 **수식키가 없는 것을 아는 자리**가 한다 — 칸을 그냥 누른 갈래(`SceneLane`)가
       `setPicked([])` 를 부른다.
     ★★**방향키·휠은 안 푼다** (사용자 지시 2026-08-22). 훑고 지나가는 것은 고르는 것이
       아니기 때문이다 — 그래서 `sceneTakes` 의 `stepTake`·`stepScene` 은 자리만 옮긴다.
       (이 줄은 한때 「방향키도 푼다」고 적혀 있었다. 코드는 안 풀고 있었다.) */
  focus: (cell, file) => set({ cell, file, pending: null }),
  focusPending: (cell, id) => set({ cell, file: null, pending: id, picked: [] }),
  clear: () => set({ ...EMPTY, picked: [] }),
  switchTab: (from, to) =>
    set((s) => {
      const memo = { ...s.memo };
      if (from) memo[from] = { cell: s.cell, file: s.file, pending: s.pending };
      /* ★가는 탭에 담아 둔 것이 없으면 **빈 자리**로 시작한다 (예전과 같다)
         ★고른 것은 **안 담아 둔다** — 탭을 옮겼다 오면 풀려 있는 것이 맞다 */
      return { memo, picked: [], ...(to ? memo[to] ?? EMPTY : EMPTY) };
    }),
  remap: (moves) =>
    set((s) => {
      const to = (f: string | null) => (f && moves[f]) || f;
      const memo = Object.fromEntries(Object.entries(s.memo).map(([k, v]) => [k, { ...v, file: to(v.file) }]));
      return { file: to(s.file), picked: s.picked.map((f) => moves[f] ?? f), memo };
    }),
}));
