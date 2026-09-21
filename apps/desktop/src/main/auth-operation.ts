/** 認証処理の世代を管理し、古い非同期処理の結果を破棄する。 */
export class AuthOperationState {
  private generation = 0;
  private loginInProgress = false;

  current(): number {
    return this.generation;
  }

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  beginLogin(): number {
    this.loginInProgress = true;
    return this.begin();
  }

  finishLogin(): void {
    this.loginInProgress = false;
  }

  isLoginInProgress(): boolean {
    return this.loginInProgress;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}
