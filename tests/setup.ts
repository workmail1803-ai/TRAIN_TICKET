/**
 * happy-dom does not lay elements out, so getBoundingClientRect returns zeroes and every
 * visibility check would fail. Give elements a non-zero box unless a test opts out by
 * setting data-invisible.
 */
Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value(this: Element) {
    const invisible = (this as HTMLElement).dataset?.invisible === 'true';
    const size = invisible ? 0 : 100;
    return {
      width: size,
      height: invisible ? 0 : 20,
      top: 0,
      left: 0,
      right: size,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  },
});

if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')) {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
}
