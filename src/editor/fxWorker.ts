/** 효과 셈을 화면 밖에서 — 강도를 끄는 동안 큰 그림에서도 화면이 멈추지 않게 (`pixels.withFx` 의 `live`) */
import { applyFx, type Fx } from "./fx";

const me = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown, t: Transferable[]) => void };
me.onmessage = (e: MessageEvent<{ id: number; data: ArrayBuffer; w: number; h: number; fx: Fx }>) => {
  const { id, data, w, h, fx } = e.data;
  const out = applyFx(new Uint8ClampedArray(data), w, h, fx);
  me.postMessage({ id, data: out.buffer }, [out.buffer]);
};
