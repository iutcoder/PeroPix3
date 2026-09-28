import { create } from "zustand";

/** 이미지 편집에서 지금 **만화 캔버스**를 보고 있나 — 앱 뼈대(`App`)가 왼쪽 패널(공통 · 컷 편집)을 세울지 이것으로 정한다.
 *  ★편집기는 지연 로드라 뼈대가 편집기 스토어를 들이면 첫 화면이 편집기를 싣게 된다 — 그래서 값 하나만 따로 둔다 (`store.ts` 가 채운다) */
export const useComicOn = create<{ on: boolean }>(() => ({ on: false }));
