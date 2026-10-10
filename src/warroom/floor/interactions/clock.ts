/** Seconds on the page's monotonic clock; office life (coffee, stand-up) runs on it. */
export const nowSeconds = (): number => performance.now() / 1000;
