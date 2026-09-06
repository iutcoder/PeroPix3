/** 검열 전 탭의 박스 맞히기. **순수 함수만** 둔다.
 *
 *  ★여기 있던 손잡이·늘리기·돌리기 셈은 걷었다 (2026-09-05) — 검열 중·후의 편집이 박스가
 *    아니라 **붓**이 되면서(`censorMask`) 박스를 옮기고 돌릴 일이 없어졌다. 남은 쓰임은
 *    검열 전 탭에서 찾은 박스를 눌러 끄고 켜는 것뿐이다.
 *  ★옛 세션의 박스는 돌아가 있을 수 있어 맞힐 때는 아직 역회전을 본다.
 */
export type Rect = [number, number, number, number];

export const center = (b: Rect) => ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });

/** 점을 중심 기준으로 **역회전**. 돌아간 박스를 반듯한 사각형처럼 다루려고 */
export function unrotate(px: number, py: number, cx: number, cy: number, angle: number) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** 어느 박스 안인가. 뒤에 그린 것부터 본다 (위에 있는 것이 먼저 잡힌다) */
export function hitBox(list: { box: Rect; rotation?: number }[], x: number, y: number): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i].box;
    const c = center(b);
    const p = unrotate(x, y, c.x, c.y, list[i].rotation ?? 0);
    if (p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3]) return i;
  }
  return -1;
}
