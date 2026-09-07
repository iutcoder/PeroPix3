/** 「비우기」 단추 — **앱 전체에서 한 모양** (사용자 지시 2026-09-07: *"'비우기' 버튼도 통일. 지금 일괄변환
 *  비우기는 이미지 삭제랑 같은 아이콘을 쓰고 있음"*).
 *
 *  ★아이콘은 **빗자루**다 — 휴지통은 「파일을 지운다」의 표식이라, 목록만 비우는 단추에 쓰면 같은 그림이
 *    다른 일을 뜻하게 된다. 비우기는 파일을 건드리지 않는다.
 *  ★상자·크기는 `FolderOpenButton` 과 같다 (같은 줄에 나란히 서는 일이 많다). `data-*` 표식은 그대로 넘긴다. */
import type { CSSProperties, MouseEventHandler } from "react";
import { Icon } from "./Icon";

const CLEAR_BTN: CSSProperties = {
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
  /** 툴팁 — 무엇을 비우는지 */
  tip: string;
  disabled?: boolean;
  style?: CSSProperties;
  [k: `data-${string}`]: string | undefined;
};

export function ClearButton({ onClick, tip, disabled, style, ...rest }: Props) {
  return (
    <button
      {...rest}
      data-clear-btn
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      style={{ ...CLEAR_BTN, ...(disabled ? { opacity: 0.5 } : {}), ...style }}
    >
      {Icon.broom}
    </button>
  );
}
