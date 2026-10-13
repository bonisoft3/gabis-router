/**
 * Generic undo/redo stack manager.
 */
export class HistoryStack<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 50) {
    this.maxDepth = maxDepth;
  }

  /**
   * Records a snapshot before a mutation. Clears the redo stack.
   */
  record(currentState: T): void {
    this.undoStack.push(currentState);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /**
   * Undoes the last mutation and saves current state for redo.
   */
  undo(currentState: T): T | null {
    if (this.undoStack.length === 0) return null;
    const prev = this.undoStack.pop()!;
    this.redoStack.push(currentState);
    if (this.redoStack.length > this.maxDepth) {
      this.redoStack.shift();
    }
    return prev;
  }

  /**
   * Redoes the last undone mutation and saves current state for undo.
   */
  redo(currentState: T): T | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop()!;
    this.undoStack.push(currentState);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    return next;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
