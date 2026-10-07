// window.desktop.onXxx 系のイベントを React のライフサイクルに合わせて購読する。
// preload の onXxx は登録解除の関数を返すので、それを useEffect の後始末で呼ぶ。
import { useEffect, useRef } from "react";

/**
 * main → renderer のイベントを購読するフック。
 *
 * @param subscribe `window.desktop.onSelection` のような、listener を受け取って
 *                  登録解除の関数を返す関数。参照が変わったときだけ購読し直す。
 * @param listener  イベントを受け取る処理。毎レンダーで新しい関数を渡しても
 *                  最新が呼ばれ、購読は張り直されない。
 */
export function useDesktopEvent<TPayload>(
  subscribe: (listener: (payload: TPayload) => void) => () => void,
  listener: (payload: TPayload) => void,
): void {
  // レンダーのたびに最新の listener へ差し替える。ref への代入を effect に
  // 寄せると StrictMode の最初のコミット前に届くイベントを拾えないため、
  // 代入自体はレンダー中に行う（書き換えは ref なので描画は壊れない）。
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(
    () =>
      // StrictMode の二重マウントでは effect が 登録→解除→登録 と走る。
      // 解除が必ず挟まるため、最終的に生きる購読は 1 つだけになる。
      subscribe((payload) => listenerRef.current(payload)),
    [subscribe],
  );
}
