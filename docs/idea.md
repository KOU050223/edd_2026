# Gakushu Sochi

## 概要

教材・開発環境・AIを横断して、個人の学習をつなぐプログラミング学習向けAIコンパニオン。

AIにコードを書いてもらうことではなく、

> AIを使うほど、自分でコードを理解・解決できるようになる

ことを目指す。

どの教材で何を学び、どのエディタで何に詰まり、何を理解できるようになったかを、一人ひとりの
Personal Learning Mapとして蓄積する。VS Codeは、その学習行動を最初に観測し支援するためのコネクタである。

コードを読んでいて分からない箇所を選択し、ショートカットからその場ですぐ質問できる。
エラーが発生した場合も、現在のコードやDiagnosticsをもとに原因を解説する。

---

## 主な体験

### コードを選択して即質問

```text
コードを選択
↓
ショートカット
↓
「これ何？」「なぜこう書く？」
↓
その場でAIが回答
```

Naniのように、必要なときだけ素早く呼び出せるUXを目指す。

### エラー解説

VS Codeのエラー情報を取得し、

- なぜエラーなのか
- どこを見るべきか
- 次に何を試すべきか

を解説する。

---

## Personal Learning Map

Gakushu Sochiは教材やツールを置き換えない。それぞれを使う中で得られる学習の証拠をつなぎ、
本人に合った次の一歩を返す中間レイヤーになる。

```text
roadmap.sh / Udemy / 書籍 / 公式ドキュメント  ── 何を学ぶか
VS Code / GitHub / AIとの質問                 ── 何に詰まり、どう解けたか
                                               ↓
                                  Personal Learning Map
                                               ↓
                          理解の振り返り / 復習 / 次の学習提案
```

教材・エディタ・AIの組み合わせはユーザーごとに異なる。最初からすべてを汎用連携するのではなく、
価値を出せる接続先を一つずつ深く対応し、本人が使う学習環境に合わせて組み替えられるようにする。

質問内容やエラーなどから、その人の理解の証拠を蓄積する。

```text
Go Roadmap

Basic Syntax   確認済み
Slice / Map    学習中
Pointer        学習中（自力で2回解決）
Interface      未観測
Concurrency    未観測
```

「何回AIを使ったか」ではなく、

- 何を理解したか
- 何が苦手か
- 最近できるようになったこと
- 次に何を学ぶとよいか

を可視化する。Conceptの体系にはroadmap.shのような外部ロードマップを参考にできるが、
理解度を外部サービスの点数として扱うのではなく、本人の行動から得られた根拠とともに表示する。

最終的には、AIへの質問が減っていくことを目指す。

ただし質問数の減少は、理解した場合と未解決のまま離脱した場合を区別できない。
そのため質問数は補助指標として扱い、自力解決の成功、同じエラーの再発減少、
確認問題の正答などと組み合わせてMapへ反映する。根拠が少ない段階で理解度を断定せず、
「未観測」「学習中」「確認済み」といった状態と確信の理由を示す。

---

## 回答のカスタマイズ

ユーザーごとに「どう教えてほしいか」も設定できる。

### Tone

- Standard
- Friendly
- Casual
- Strict
- Concise

### Teaching Style

- Answer First
- Socratic
- Example Heavy
- Deep Explanation

### Companion

「優しい先輩」「厳しめのメンター」「簡潔なAI」などのプリセットに加え、Proでは独自のキャラクターや教え方を設定できる。

単なる口調変更ではなく、

```text
Personality
+
Teaching Style
+
Skill Level
+
Learning History
```

を組み合わせて、自分専用の先生にしていく。

---

## 対象ユーザー

メインターゲットは、複数の教材・AI・開発環境を使いながら、学習が断片化しているDeveloperである。

> 自分に合う学習環境を使いながら、新しい知識・技術を身につけたいDeveloper

特に、

- 若手エンジニア
- 新しい言語/FWを学んでいるエンジニア
- 就活中・駆け出しエンジニア
- 大学生・専門学生

を想定する。

「プログラミング初心者」だけではなく、

> TypeScript経験者がGoを学ぶ

のような特定技術における初心者も対象。

---

## AI

特定のLLMには依存しない。

```text
AI Provider
├─ VS Code Language Model / User's Copilot
├─ Managed AI（API Server 経由の Gemini）
├─ BYOK
└─ Local LLM
```

基本はユーザー自身が利用できるAIを優先し、運営側のAIコストを抑える。

学習履歴は巨大なRAGやVector DBを使わず、イベントの追記ログを正本として
API Server（D1）へ同期する。クライアントが持つのはオフライン用のローカルキャッシュである。
同期の契約（冪等性）は `docs/architecture.md`「オフラインと競合」、削除は
`docs/data-privacy.md`、再送方針は `docs/api-ops.md` が正典である。

---

## MVP

最初はVS Codeを最初のコネクタとして、以下に絞る。Webアプリや他エディタとの連携を前提にしないが、
将来のPersonal Learning Mapに接続できるConceptと学習証拠のモデルで保存する。

1. コード選択 → ショートカット → AI質問
2. エラー → AI解説
3. 質問から学習Conceptを抽出
4. 基本Personal Learning Map
5. 回答スタイル設定

AI Agentや大規模なコード生成、教材・他エディタ・GitHubとの連携は実装しない。
それらは、VS Codeで学習ループの価値を検証してから、優先度順にコネクタとして追加する。

---

## 収益化

基本は Free + Pro。

### Free

- コードへの質問
- エラー解説
- 基本Personal Learning Map
- 基本的な回答カスタマイズ

### Pro

- 長期学習履歴
- 詳細Personal Learning Map
- 過去のつまずきを考慮した回答
- Weekly / Monthly Review
- 学習ロードマップ
- 復習・Personalized Challenge
- Custom Companion
- 詳細なTeaching Style設定
- 複数端末同期

ProではAI利用量そのものではなく、

> Long-term Memory + Personalized Teaching + Custom Companion

に課金する。

---

## コンセプト

一般的なCoding AIは、

> どうすればコードを早く完成できるか

を支援し、教材やロードマップは何を学ぶかを示す。

Gakushu Sochiは、教材・AI・開発環境を個人に合わせてつなぎ、

> どうすれば次はAIなしでも理解・解決できるようになるか

を支援する。

Copilotはコードを完成させる。
Gakushu Sochiは、あなたを成長させる。
