/** 「폴더 열기」 단추 — **앱 전체에서 한 모양** (사용자 지시 2026-09-07: *"모든 폴더열기 버튼들 양식 통일.
 *  텍스트 없이 폴더 아이콘만. 버튼 박스 존재"*).
 *
 *  ★자리마다 따로 그리던 것(맨 아이콘·글자 단추·상자 단추)을 여기 하나로 모았다 — 캔버스 탭 줄,
 *    그림 동작 줄, 갤러리 머리, 검열 상단, 일괄 변환, 파일 관리. 어디서든 같은 상자·같은 아이콘이다.
 *  ★무엇을 여는지는 툴팁(`tip`)이 말한다. `data-*` 표식은 그대로 받아 넘긴다 (판정·QA 가 그것으로 찾는다). */
import type { CSSProperties, MouseEventHandler } from "react";
import { Icon } from "./Icon";

const FOLDER_BTN: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  boxSizing: "border-box",
  height: 24,
  minWidth: 28,
  padding: "0 var(--sp-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  flexShrink: 0,
};

type Props = {
  onClick: MouseEventHandler<HTMLButtonElement>;
  /** 툴팁 — 무엇을 여는지 */
  tip: string;
  disabled?: boolean;
  style?: CSSProperties;
  [k: `data-${string}`]: string | undefined;
};

export function FolderOpenButton({ onClick, tip, disabled, style, ...rest }: Props) {
  return (
    <button
      {...rest}
      data-folder-open
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      style={{ ...FOLDER_BTN, ...(disabled ? { opacity: 0.5 } : {}), ...style }}
    >
      {Icon.folderOpen}
    </button>
  );
}
