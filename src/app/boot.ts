/**
 * Waits on everything the first screen needs, reporting the share settled after each one.
 * A failed task still counts as done: the screen that needs it will show its own error, and
 * the title screen must never hang on it.
 */
export async function trackLoading(tasks: readonly PromiseLike<unknown>[], onProgress: (fraction: number) => void): Promise<void> {
  if (tasks.length === 0) {
    onProgress(1);
    return;
  }
  let settled = 0;
  const settle = () => {
    settled += 1;
    onProgress(settled / tasks.length);
  };
  await Promise.all(tasks.map((task) => Promise.resolve(task).then(settle, settle)));
}

/** Resolves once the image is fetched and decoded, so it appears whole rather than painting in. */
export function loadImage(src: string): Promise<void> {
  const image = new Image();
  image.src = src;
  return image.decode();
}
