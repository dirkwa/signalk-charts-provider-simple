/**
 * Runs the steps handed to it one at a time, in the order given. A step that
 * fails rejects its own promise and does not stop the steps after it.
 */
export function serialQueue(): <T>(step: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(step: () => Promise<T>): Promise<T> => {
    const run = tail.then(step, step);
    tail = run.catch(() => undefined);
    return run;
  };
}
