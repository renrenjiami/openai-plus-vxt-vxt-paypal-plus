const STOP_FLAG_KEY = 'opx.flow.stopRequested';
const STOP_ERROR_MESSAGE = '流程已被用户停止';

let stopFlagCache = false;
let stopFlagListenerInstalled = false;

export class FlowStoppedError extends Error {
  constructor() {
    super(STOP_ERROR_MESSAGE);
    this.name = 'FlowStoppedError';
  }
}

export function isFlowStoppedError(error: unknown): boolean {
  if (error instanceof FlowStoppedError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  return message === STOP_ERROR_MESSAGE;
}

export async function isFlowStopRequested(): Promise<boolean> {
  installStopFlagListener();
  try {
    const data = await browser.storage.local.get(STOP_FLAG_KEY);
    stopFlagCache = Boolean(data[STOP_FLAG_KEY]);
  } catch {
    // ignore
  }
  return stopFlagCache;
}

export async function requestFlowStop(): Promise<void> {
  stopFlagCache = true;
  try {
    await browser.storage.local.set({ [STOP_FLAG_KEY]: true });
  } catch {
    // ignore
  }
}

export async function clearFlowStop(): Promise<void> {
  stopFlagCache = false;
  try {
    await browser.storage.local.set({ [STOP_FLAG_KEY]: false });
  } catch {
    // ignore
  }
}

export function throwIfStopped(): void {
  if (stopFlagCache) {
    throw new FlowStoppedError();
  }
}

function installStopFlagListener(): void {
  if (stopFlagListenerInstalled || typeof browser === 'undefined') {
    return;
  }
  stopFlagListenerInstalled = true;
  try {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }
      const entry = changes[STOP_FLAG_KEY];
      if (entry) {
        stopFlagCache = Boolean(entry.newValue);
      }
    });
  } catch {
    // ignore
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (stopFlagCache) {
        reject(new FlowStoppedError());
        return;
      }
      if (Date.now() - start >= ms) {
        resolve();
        return;
      }
      window.setTimeout(tick, Math.min(100, Math.max(25, ms - (Date.now() - start))));
    };
    tick();
  });
}

export async function humanPause(min = 250, max = 850): Promise<void> {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(duration);
}

export interface WaitOptions {
  timeout?: number;
  root?: ParentNode;
  initial?: boolean;
}

export function waitForElement<T extends Element = HTMLElement>(
  selector: string,
  options: WaitOptions = {},
): Promise<T> {
  const { timeout = 10000, root, initial = true } = options;
  return new Promise<T>((resolve, reject) => {
    throwIfStopped();

    if (initial) {
      const existing = (root || document).querySelector<T>(selector);
      if (existing) {
        resolve(existing);
        return;
      }
    }

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };

    const observer = new MutationObserver(() => {
      if (stopFlagCache) {
        cleanup();
        reject(new FlowStoppedError());
        return;
      }
      const el = (root || document).querySelector<T>(selector);
      if (el) {
        cleanup();
        resolve(el);
      }
    });

    observer.observe((root as Node | undefined) || document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${selector} 超时（${timeout}ms）`));
    }, timeout);
  });
}

export function waitForElementByText(
  selector: string,
  pattern: RegExp,
  options: WaitOptions = {},
): Promise<HTMLElement> {
  const { timeout = 10000, root } = options;
  const scope: ParentNode = root || document;
  return new Promise<HTMLElement>((resolve, reject) => {
    throwIfStopped();

    const search = (): HTMLElement | null => {
      for (const el of Array.from(scope.querySelectorAll<HTMLElement>(selector))) {
        if (pattern.test(normalizeText(el.textContent || ''))) {
          return el;
        }
      }
      return null;
    };

    const existing = search();
    if (existing) {
      resolve(existing);
      return;
    }

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };

    const observer = new MutationObserver(() => {
      if (stopFlagCache) {
        cleanup();
        reject(new FlowStoppedError());
        return;
      }
      const el = search();
      if (el) {
        cleanup();
        resolve(el);
      }
    });

    observer.observe((root as Node | undefined) || document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待文本 ${pattern} 超时（${timeout}ms）`));
    }, timeout);
  });
}

export interface WaitUntilOptions {
  timeout?: number;
  intervalMs?: number;
}

export async function waitUntil<T>(
  predicate: () => T | null | undefined | false,
  options: WaitUntilOptions = {},
): Promise<T> {
  const { timeout = 10000, intervalMs = 250 } = options;
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    throwIfStopped();
    const value = predicate();
    if (value) {
      return value as T;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil 超时（${timeout}ms）`);
}

export function isVisibleElement(element: Element | null | undefined): element is HTMLElement {
  if (!element) return false;
  const htmlElement = element as HTMLElement;
  if ('disabled' in htmlElement && Boolean((htmlElement as HTMLInputElement).disabled)) {
    return false;
  }
  const style = window.getComputedStyle(htmlElement);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
    return false;
  }
  const rect = htmlElement.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function normalizeText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  emitChange(input);
}

export function emitChange(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

export function dispatchClick(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
    const isPointer = type.startsWith('pointer');
    const EventCtor = isPointer ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: type.endsWith('down') ? 1 : 0,
      pointerId: 1,
      pointerType: 'mouse',
    }));
  }
  element.click();
}

export function getVisibleControls<T extends HTMLElement = HTMLElement>(
  selector: string,
  root?: ParentNode,
): T[] {
  const scope: ParentNode = root || document;
  return Array.from(scope.querySelectorAll<T>(selector)).filter((el): el is T => isVisibleElement(el));
}

export function getVisibleTextInputs(root?: ParentNode): HTMLInputElement[] {
  return getVisibleControls<HTMLInputElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="search"], input:not([type])',
    root,
  );
}

export type TextPattern = string | RegExp;

function matchesPattern(text: string, pattern: TextPattern): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(text);
  }
  return text.includes(pattern.toLowerCase());
}

function matchesAnyPattern(text: string, patterns: TextPattern[]): boolean {
  return patterns.some((pattern) => matchesPattern(text, pattern));
}

function getActionText(el: Element): string {
  const html = el as HTMLElement;
  return normalizeText([
    html.innerText,
    html.textContent,
    html.getAttribute('aria-label'),
    html.getAttribute('title'),
    html.getAttribute('value'),
    html.getAttribute('data-testid'),
  ].filter(Boolean).join(' '));
}

export function findClickableByText(
  patterns: TextPattern[],
  root?: ParentNode,
): HTMLElement | null {
  const candidates = getVisibleControls<HTMLElement>(
    'button, a, [role="button"], [role="radio"], [data-testid], label, input[type="submit"], input[type="button"]',
    root,
  );
  for (const el of candidates) {
    if (matchesAnyPattern(getActionText(el), patterns)) {
      return el;
    }
  }
  return null;
}

function getInputHintText(input: HTMLInputElement): string {
  const labelText = input.id
    ? document.querySelector(`label[for="${cssEscape(input.id)}"]`)?.textContent || ''
    : '';
  const parentLabel = input.closest('label')?.textContent || '';
  return normalizeText([
    labelText,
    parentLabel,
    input.getAttribute('aria-label'),
    input.getAttribute('placeholder'),
    input.getAttribute('name'),
    input.getAttribute('id'),
    input.getAttribute('data-testid'),
    input.getAttribute('autocomplete'),
  ].filter(Boolean).join(' '));
}

export function findInputByText(
  patterns: TextPattern[],
  root?: ParentNode,
): HTMLInputElement | null {
  for (const input of getVisibleTextInputs(root)) {
    if (matchesAnyPattern(getInputHintText(input), patterns)) {
      return input;
    }
  }
  return null;
}

export function findInputsByText(
  patterns: TextPattern[],
  root?: ParentNode,
): HTMLInputElement[] {
  return getVisibleTextInputs(root).filter((input) =>
    matchesAnyPattern(getInputHintText(input), patterns));
}

export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}
