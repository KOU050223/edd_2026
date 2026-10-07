// 非同期読み込みの世代管理。古い応答で新しい表示を上書きしないための
// 最小の仕掛け（.agents/rules/rules.md RULE-005）。
import { useMemo, useRef } from "react";

export interface LatestRequest {
  /**
   * 新しい読み込みを開始し、その世代番号を返す。
   * 前の世代はこの時点で「古い」扱いになる。
   */
  begin: () => number;
  /**
   * 渡した世代番号が今も最新かを返す。
   * await 後の反映前に必ず呼び、false なら応答を捨てる。
   */
  isLatest: (generation: number) => boolean;
}

/**
 * 世代番号で「再読み込みされた読み込み」の古い応答を捨てるためのフック。
 *
 * 使い方:
 * ```ts
 * const request = useLatestRequest();
 * const generation = request.begin();
 * const data = await load();
 * if (!request.isLatest(generation)) return; // 古い応答なので捨てる
 * setState(data);
 * ```
 */
export function useLatestRequest(): LatestRequest {
  const generationRef = useRef(0);
  return useMemo(
    () => ({
      begin: () => ++generationRef.current,
      isLatest: (generation) => generation === generationRef.current,
    }),
    [],
  );
}
