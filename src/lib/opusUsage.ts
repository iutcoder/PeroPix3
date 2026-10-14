/** Opus 무료 생성 **잔량** — 뜻을 정하는 곳은 여기 하나다.
 *
 *  ★★V5 부터 **Opus 무료가 무제한이 아니다** (공홈 `opusUsageLimit` 능력).
 *    공홈 문구: *"Your Opus subscription includes free NovelAI Diffusion V5 generations at
 *    normal resolutions and up to 28 steps. This allowance is limited and refills
 *    automatically over time. When it runs out, you can still generate images by spending
 *    Anlas."*
 *
 *  ★값은 서버가 `/user/subscription` 의 `usage` 를 그대로 실어 온다 (`store/sub.ts`).
 *    식은 공홈 번들의 `$0`·`S3`·`$`·`OH`·`RM` 을 그대로 옮긴 것이다 (2026-08-21 대조).
 *  ★★**무료 판정에 쓰이는 것은 `isNegative` 하나**다 (`lib/anlas.ts`). 퍼센트가 낮아도
 *    바닥나기 전까지는 무료다 — 퍼센트로 미리 끄면 실제 청구와 어긋난다.
 */
import type { OpusUsage } from "../store/sub";

/** 화면에 **적을** 남은 비율. 빚진 상태면 0 이다 (공홈 `$0`).
 *
 *  ★★**100 을 넘으면 넘은 대로 적는다** (사용자 지적 2026-08-23: *"opus 할당량이 100%를
 *    초과할수도 있는데 앱에서는 100%로만 보임"*). 값은 서버가 `/user/subscription` 의
 *    `usage` 를 **그대로** 실어 온다 — 못 가져온 것이 아니라 여기서 `Math.min(100, …)` 으로
 *    눌러 놓고 있었다. 눌러 두면 「가득 찼다」와 「가득 넘겼다」가 화면에서 같아 보인다.
 *  ★아래끝의 0 은 그대로 둔다 — 음수는 `isNegative` 가 이미 말한다. */
export const usagePercent = (u: OpusUsage): number => (u.isNegative ? 0 : Math.max(0, u.percent));


/** ★★Extra Usage — Opus Usage Boost 로 산 몫 (%). 없으면 0 (공홈 `usagePurchasedPercent`, 2026-10-14 대조).
 *  일반 잔량을 다 쓴 뒤에 쓰인다. ★무료 판정은 여전히 `isNegative` 하나다 — 서버가 이 몫까지 보고 정한다 */
export const usagePurchased = (u: OpusUsage): number => Math.max(0, u.purchasedPercent ?? 0);

/** 경고해야 하는 상태인가 — 바닥났거나 5% 미만, **그리고 Extra Usage 도 5% 미만** (공홈 `usageIsLow`).
 *  ★Extra Usage 가 남아 있으면 일반 잔량이 0 이어도 계속 무료로 생성된다 — 경고하면 틀린 말이다 */
export const usageLow = (u: OpusUsage): boolean => (u.isNegative || u.percent < 5) && usagePurchased(u) < 5;

/** 시간당 회복 비율 (%/h, 소수 한 자리. 공홈 `$`) */
export const usageRefillPerHour = (u: OpusUsage): number =>
  u.timeUntilNextPercent <= 0 ? 0 : Math.round((3600 / u.timeUntilNextPercent) * 10) / 10;

/** 100% 가 되기까지 남은 **초** (공홈 `OH`).
 *  ★빚진 상태면 `percent` 가 음수라 `+100` 을 해서 되갚는 몫까지 센다 */
export const usageFullInSeconds = (u: OpusUsage): number => {
  if (u.timeUntilNextPercent <= 0) return 0;
  const left = u.isNegative ? u.percent + 100 : 100 - u.percent;
  // ★★이미 100 을 넘겼으면 **채울 것이 없다** — 0 을 준다. 예전에는 `100 - percent` 가 음수가
  //   되어 「-3분 남음」 같은 말이 나왔다 (넘긴 값을 그대로 적게 되면서 드러난 자리).
  return left <= 0 ? 0 : left * u.timeUntilNextPercent;
};

/** 초 → `3h 20m` 꼴. ★분 미만은 올려서 **1m** 으로 — `0m` 은 다 됐다는 뜻으로 읽힌다 */
export function usageDuration(seconds: number): string {
  const mins = Math.max(1, Math.ceil(seconds / 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
