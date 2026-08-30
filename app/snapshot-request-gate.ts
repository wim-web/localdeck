export class SnapshotRequestGate {
  private generation = 0;
  private readonly activeGenerations = new Set<number>();

  start(quiet: boolean): number | null {
    if (quiet && this.activeGenerations.has(this.generation)) return null;

    this.generation += 1;
    this.activeGenerations.add(this.generation);
    return this.generation;
  }

  finish(generation: number): void {
    this.activeGenerations.delete(generation);
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}
