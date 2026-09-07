/** 조수가 **어디를 고쳤나**, 그리고 그 자리로 가기.
 *
 *  ★★사용자 지시 2026-08-24: *"실제로 앱의 데이터를 수정한 경우에 반드시 채팅 로그에
 *    구분되는 양식으로 명시되고, 그걸 누르면 수정된 위치를 열어 주면 좋겠다."*
 *
 *  ★고치는 도구는 `did`(무엇을)와 함께 `at`(어디를)을 돌려준다 (`backend/agent.py` 의
 *    `_mark`). 읽기 도구는 안 돌려준다 — 그것이 「고침 줄」과 「읽기 줄」을 가르는 기준이다.
 *  ★**저장 장치를 따로 안 만든다.** `at` 은 도구 결과 JSON 안에 있고 대화가 그대로
 *    저장되므로, 나중에 열어도 눌린다. 옛 대화에는 `at` 이 없어 안 눌릴 뿐이다.
 *  ★가서 **강조까지** 한다 (`useUi.reveal`). 열어 놓고 「어디가 바뀌었지」를 다시 찾게 하면
 *    절반만 한 것이다.
 */
import { useUi } from "../store/ui";
import { useWs } from "../store/workspace";

export type AgentAt =
  | { kind: "card"; cardKind: string; id: string; log?: string }
  | {
      kind: "prompt";
      workspace?: string;
      tab?: string;
      sceneGroup?: string;
      area?: string;
      /** 씬 칸을 고친 것이면 그 씬 id — 씬은 왼쪽 패널이 아니라 **캔버스**에 산다 */
      scene?: string;
      label?: string;
      log?: string;
    }
  | { kind: "file"; workspace?: string; path?: string; log?: string }
  | { kind: "guide"; log?: string }
  | { kind: "queue"; workspace?: string; sceneGroup?: string; log?: string };

/** 그 자리를 여는 문구 (툴팁) — **무엇이 열리는지** 미리 말해 준다 */
export function atLabel(at: AgentAt, t: (k: string) => string): string {
  switch (at.kind) {
    case "card": return t("ai.atCard");
    case "prompt": return t("ai.atPrompt");
    case "file": return t("ai.atFile");
    case "guide": return t("ai.atGuide");
    case "queue": return t("ai.atQueue");
  }
}

/** 그 자리로 간다. ★못 가면 **조용히 넘기지 않는다** — 왜 못 갔는지 말한다 */
export async function openAt(at: AgentAt): Promise<void> {
  const ui = useUi.getState();
  const ws = useWs.getState();

  if (at.kind === "guide") {
    ui.openSettings("llm");
    return;
  }
  if (at.kind === "card") {
    ui.setMode("generate");
    // 덱은 종류별 탭이라 그 종류를 먼저 편다 (`cards/DeckPanel` 의 `view.tab.deck`)
    ui.setView("tab", "deck", at.cardKind as never);
    ui.reveal("right", `card:${at.id}`, true);
    return;
  }
  if (at.kind === "file") {
    ui.setMode("utility");
    if (at.path) ui.reveal("left", `file:${at.path}`, true);
    return;
  }

  // prompt·queue — 워크스페이스·탭·세트를 차례로 맞춘다
  if (at.workspace && at.workspace !== ws.current) {
    await ws.open(at.workspace);
  }
  ui.setMode("generate");
  const spec = useWs.getState().spec;
  if (at.kind === "prompt" && at.tab && spec?.tabs?.some((c) => c.id === at.tab)) {
    useWs.getState().switchTab(at.tab);
  }
  const groupId = at.kind === "prompt" ? at.sceneGroup : at.sceneGroup;
  if (groupId && useWs.getState().spec?.sceneGroups.some((x) => x.id === groupId)) {
    useWs.getState().setActiveSceneGroup(groupId);
  }
  if (at.kind === "prompt") {
    /* ★씬 칸은 **골라서** 데려간다 — 캔버스에 사는 것이라 왼쪽 패널의 `reveal` 이 못 닿는다.
       고르면 그 칸이 화면에 들어오고 테두리가 선다 (생성이 끝난 칸을 고르는 길과 같다). */
    if (at.scene) {
      const { useSceneFocus } = await import("../store/sceneFocus");
      useSceneFocus.getState().focus(at.scene, null);
      return;
    }
    /* ★★**고친 섹션을 강조한다** (사용자 지적 2026-08-25).
       예전에는 `block:<블록이름>` 을 켰는데 **그 표식을 아무도 안 읽었고**, 이름이 없으면
       `params`(생성 설정)로 떨어져 *"스타일을 눌렀는데 하단 생성 설정이 강조"* 됐다.
       ★자리를 가르는 것은 `area` 다: `base`·`baseUc` 는 스타일 섹션, 그 밖은 **캐릭터 이름**
         (`edit_style_card`·`edit_character` 의 `area` 규약). 표식은 `PromptSections` 가 읽는다.
       ★★`params` 로 떨어지지 않는다 — 갈 곳을 모르면 **패널만 편다.** 엉뚱한 자리를
         강조하는 것은 아무것도 안 하는 것보다 나쁘다. */
    const area = at.area ?? "";
    if (!area) {
      ui.reveal("left", "prompt", true);
      return;
    }
    if (area === "base" || area === "baseUc") {
      ui.reveal("left", "prompt:base", true);
      return;
    }
    // `<이름>:uc` 꼴이면 이름만 떼어 낸다
    ui.reveal("left", `prompt:${area.split(":")[0]}`, true);
  }
}
