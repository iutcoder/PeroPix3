/** **액션 레지스트리** — 조수가 앱에 시킬 수 있는 일이 정의되는 **한 자리** (2026-08-24).
 *
 *  ★★왜 만들었나: 액션 하나가 **두 곳**에 나뉘어 있었다 — 백엔드의 도구 표
 *    (`backend/agent.py` 의 `_table`)와 앱의 분기(`store/queue.ts` 의 `runAction`).
 *    한쪽만 고치면 조용히 어긋난다. 실제로 `generate` 스키마는 `set` 을 받는데 앱은
 *    `args.tab` 만 읽어서, 조수가 세트를 지정해도 **오류 없이 활성 세트에 생성됐다**
 *    (적대 검토 2026-08-24). Anlas 가 나가고 되돌릴 수 없다.
 *
 *  ★이름·설명·**인자 형식**·실행 함수를 한 덩이로 적는다. 목록은 빌드할 때 뽑아
 *    백엔드에 넣는다 (`scripts/gen-actions.mjs`) — 앱이 접속할 때 올려 보내던 방식은
 *    소켓 타이밍(HMR·새로고침)에 걸려 **도구가 0개**로 보였다 (`backend/agent.py` 머리).
 *
 *  ★**결과를 반드시 돌려준다** (`{ok,did,at}` 또는 `{error}`). 지금 스토어 함수들은
 *    실패해도 조용히 `return` 이라, 조수가 성공으로 알고 "지웠습니다"라고 말한다.
 */

/** 인자 하나의 형식 — JSON Schema 로 그대로 나간다 (공급자가 이걸로 사전 검사한다) */
export type ArgSpec = {
  type: "string" | "number" | "boolean" | "array" | "object";
  desc: string;
  /** 배열일 때 원소의 형 */
  items?: { type: string };
  /** 빠뜨리면 안 되는 인자 */
  required?: boolean;
};

/** 조수가 스스로 고칠 수 있는 오류 (`docs/agent-actions-design.md` 2-4).
 *
 *  ★★`retry` 를 반드시 적는다 — **시간 초과는 `unsafe`** 다. 지금은 "앱이 제때 답하지
 *    않았습니다"만 와서 조수가 다시 시도하고, 생성이면 Anlas 가 두 배로 나간다. */
export type ActionError = {
  code: "not_found" | "ambiguous" | "unknown_field" | "refused" | "blocked" | "no_workspace";
  what?: string;
  given?: string;
  /** 비슷한 것 셋 — 이것만 있으면 조수가 대개 한 번에 고친다 */
  candidates?: string[];
  retry: "safe" | "unsafe" | "never";
  message: string;
};

export type ActionResult =
  | { ok: true; did: string; at?: Record<string, unknown>; [k: string]: unknown }
  | { error: ActionError };

/** 위험도 — **자동 승인**이 이 값을 본다 (2-5).
 *
 *  ★`ask`  : 되돌릴 수 있는 일. 「자동 승인」을 켜면 안 묻는다.
 *  ★`hard` : **되돌릴 수 없는 일** — 카드·씬 삭제(로그까지 비운다)와 **Anlas 가 나가는 생성**.
 *            「되돌릴 수 없는 것은 언제나 묻기」가 켜져 있으면 자동 승인이어도 묻는다.
 *  ★`none` : 읽기·값 편집처럼 물을 것이 없는 일.
 *  ★★생성의 위험도는 **고정이 아니다** — Anlas 가 나가느냐로 갈린다 (사용자 결정 2026-08-24).
 *    그래서 `confirm` 을 함수로도 줄 수 있게 했다. */
export type Risk = "none" | "ask" | "hard";

export type ActionDef = {
  id: string;
  /** 조수가 읽는 설명 — 언제 쓰는지까지 적는다 */
  desc: string;
  /** ★★**승인 카드에 뜨는 한 줄** (사람이 읽는다). `desc` 를 그대로 쓰면 안 된다 —
   *  그쪽은 LLM 용이라 길고 마크다운 표시가 섞여 있어, 카드가 설명서처럼 보인다
   *  (QA 실측 2026-08-25). 승인이 뜰 수 있는 액션(`confirm` 이 none 이 아닌 것)은 반드시 적는다. */
  title?: string;
  args?: Record<string, ArgSpec>;
  /** 물어야 하나. 함수면 인자를 보고 그때 정한다 (생성의 Anlas 판정) */
  confirm?: Risk | ((a: Record<string, any>) => Promise<Risk> | Risk);
  /** 승인 카드에 띄울 문구 — 무엇이 사라지는지·얼마가 드는지를 **미리 세어** 보여 준다 */
  preview?: (a: Record<string, any>) => Promise<string> | string;
  /** 닫아 둔 기능의 액션 — 그 깃발(`comic.COMIC_READY`)이 닫혀 있으면 조수 도구 목록에서 빠진다 (`scripts/gen-actions.mjs`) */
  gate?: "comic";
  run: (a: Record<string, any>) => Promise<ActionResult> | ActionResult;
};

const REG = new Map<string, ActionDef>();

/** 기능 코드 옆에서 부른다. ★같은 id 를 두 번 등록하면 **바로 알린다** —
 *  조용히 덮으면 나중 것이 이겨서 어느 쪽이 도는지 알 수 없다. */
export function defineAction(def: ActionDef): void {
  if (REG.has(def.id)) throw new Error(`액션 id 가 겹칩니다: ${def.id}`);
  REG.set(def.id, def);
}

export const getAction = (id: string): ActionDef | undefined => REG.get(id);
export const allActions = (): ActionDef[] => [...REG.values()];

/** 오류를 만드는 짧은 길 — 부르는 쪽이 `retry` 를 빠뜨리지 않게 기본을 준다 */
export const err = (
  code: ActionError["code"],
  message: string,
  extra: Partial<ActionError> = {},
): { error: ActionError } => ({ error: { code, message, retry: "safe", ...extra } });

/** 비슷한 이름 셋 — `not_found` 에 얹으면 조수가 대개 한 번에 고친다.
 *  ★맞춤법 교정이 아니라 **골라 주기**다: 부분 일치면 충분하고, 못 찾으면 앞의 셋을 준다. */
export function nearBy(want: string, names: string[]): string[] {
  const w = want.trim().toLowerCase();
  if (!w) return names.slice(0, 3);
  const hit = names.filter((n) => n.toLowerCase().includes(w) || w.includes(n.toLowerCase()));
  return (hit.length ? hit : names).slice(0, 3);
}
