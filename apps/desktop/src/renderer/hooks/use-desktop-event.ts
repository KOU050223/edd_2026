// window.desktop.onXxx 系のイベントを React のライフサイクルに合わせて購読する。
// preload の onXxx は登録解除の関数を返すので、それを useEffect の後始末で呼ぶ。
import { useEffect, useEffectEvent } from "react";

/**
 * main → renderer のイベントを購読するフック。
 *
 * @param subscribe `window.desktop.onSelection` のような、listener を受け取って
 *                  登録解除の関数を返す関数。参照が変わったときだけ購読し直す。
 * @param listener  イベントを受け取る処理。useEffectEvent で包むため、
 *                  毎レンダーで新しい関数を渡しても最新が呼ばれ、購読は張り直されない。
 */
export function useDesktopEvent<TPayload>(
  subscribe: (listener: (payload: TPayload) => void) => () => void,
  listener: (payload: TPayload) => void,
): void {
  const onEvent = useEffectEvent(listener);
  useEffect(
    () =>
      // StrictMode の二重マウントでは effect が 登録→解除→登録 と走る。
      // 解除が必ず挟まるため、最終的に生きる購読は 1 つだけになる。
      subscribe((payload) => onEvent(payload)),
    // useEffectEvent の返り値は deps に入れない（eslint-plugin-react-hooks も
    // 警告する）。安定した参照として扱われ、購読の張り直しは起きない。
    [subscribe],
  );
}
