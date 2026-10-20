import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStack } from '../src/pronto/route-domain.js';

test('HistoryStack initial state', () => {
  const stack = new HistoryStack<string>(5);
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.canRedo(), false);
  assert.equal(stack.undo('curr'), null);
  assert.equal(stack.redo('curr'), null);
});

test('HistoryStack undo and redo sequence', () => {
  const stack = new HistoryStack<number>(5);

  // Initial: 0
  stack.record(0);
  // Transition to 1
  assert.equal(stack.canUndo(), true);
  assert.equal(stack.canRedo(), false);

  stack.record(1);
  // Transition to 2
  assert.equal(stack.canUndo(), true);
  assert.equal(stack.canRedo(), false);

  // Undo back from 2 -> restores 1
  const prev1 = stack.undo(2);
  assert.equal(prev1, 1);
  assert.equal(stack.canUndo(), true);
  assert.equal(stack.canRedo(), true);

  // Undo back from 1 -> restores 0
  const prev0 = stack.undo(1);
  assert.equal(prev0, 0);
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.canRedo(), true);

  // Redo from 0 -> restores 1
  const next1 = stack.redo(0);
  assert.equal(next1, 1);
  assert.equal(stack.canUndo(), true);
  assert.equal(stack.canRedo(), true);

  // Redo from 1 -> restores 2
  const next2 = stack.redo(1);
  assert.equal(next2, 2);
  assert.equal(stack.canUndo(), true);
  assert.equal(stack.canRedo(), false);
});

test('HistoryStack clears redo on new record action', () => {
  const stack = new HistoryStack<string>(5);
  stack.record('A'); // state is B
  const prevA = stack.undo('B');
  assert.equal(prevA, 'A');
  assert.equal(stack.canRedo(), true);

  // New action occurs while in undone state
  stack.record('A'); // state is C
  assert.equal(stack.canRedo(), false);
});

test('HistoryStack enforces max depth', () => {
  const stack = new HistoryStack<number>(3);
  stack.record(1);
  stack.record(2);
  stack.record(3);
  stack.record(4);

  // Only 3 items kept: 2, 3, 4
  assert.equal(stack.undo(5), 4);
  assert.equal(stack.undo(4), 3);
  assert.equal(stack.undo(3), 2);
  assert.equal(stack.canUndo(), false);
});
