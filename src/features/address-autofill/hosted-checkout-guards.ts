import { getVisibleControls, isVisibleElement, normalizeText, setNativeValue } from '../../app/dom-utils';

export const HOSTED_CHECKOUT_HOST_PATTERN = /(?:^|\.)pay\.openai\.com$|(?:^|\.)checkout\.stripe\.com$/i;

export function isHostedCheckoutPage(): boolean {
  const host = String(location?.host || '').toLowerCase();
  return host === 'pay.openai.com' ||
    host.endsWith('.pay.openai.com') ||
    host === 'checkout.stripe.com' ||
    host.endsWith('.checkout.stripe.com');
}

const AUTOCOMPLETE_SELECTORS = [
  '.AddressAutocomplete-results',
  '[class*="AddressAutocomplete"]',
  '#billing-address-autocomplete-results',
].join(', ');

let autocompleteObserver: MutationObserver | null = null;

export function hideHostedAutocomplete(): void {
  document.querySelectorAll<HTMLElement>(AUTOCOMPLETE_SELECTORS).forEach((node) => {
    try {
      node.style.setProperty('display', 'none', 'important');
      node.style.setProperty('visibility', 'hidden', 'important');
      node.style.setProperty('pointer-events', 'none', 'important');
      node.style.setProperty('height', '0', 'important');
      node.style.setProperty('overflow', 'hidden', 'important');
    } catch {
      // readonly style fail silently
    }
  });
}

export function startAutocompleteObserver(): void {
  if (autocompleteObserver || !isHostedCheckoutPage()) {
    return;
  }
  autocompleteObserver = new MutationObserver(() => hideHostedAutocomplete());
  autocompleteObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
}

export function stopAutocompleteObserver(): void {
  if (!autocompleteObserver) {
    return;
  }
  autocompleteObserver.disconnect();
  autocompleteObserver = null;
}

const CAPTCHA_DETECT_SELECTORS = [
  'iframe[name="recaptcha"]',
  '#captchaHeading',
  '#captcha-standalone',
  'form[action="/auth/validatecaptcha"]',
].join(', ');

const CAPTCHA_REMOVE_SELECTORS = [
  '#captcha-standalone',
  '.captcha-overlay',
  '.captcha-container',
];

export function hasCaptcha(): boolean {
  return Boolean(document.querySelector(CAPTCHA_DETECT_SELECTORS));
}

export function removeCaptcha(): boolean {
  let removed = false;
  for (const selector of CAPTCHA_REMOVE_SELECTORS) {
    document.querySelectorAll(selector).forEach((node) => {
      try {
        node.remove();
        removed = true;
      } catch {
        // ignore
      }
    });
  }
  return removed;
}

export function hasVerificationPopup(): boolean {
  return Boolean(document.getElementById('ci-ciBasic-0'));
}

export interface FillVerificationCodeResult {
  ok: boolean;
  filled: number;
  message: string;
}

export function fillVerificationCode(rawCode: string): FillVerificationCodeResult {
  const code = String(rawCode || '').replace(/\D+/g, '').slice(0, 6);
  if (code.length !== 6) {
    return { ok: false, filled: 0, message: '验证码必须是 6 位数字' };
  }
  let filled = 0;
  for (let index = 0; index < 6; index += 1) {
    const input = document.getElementById(`ci-ciBasic-${index}`) as HTMLInputElement | null;
    if (!input) {
      return { ok: false, filled, message: `未找到验证码输入框 ci-ciBasic-${index}` };
    }
    setNativeValue(input, code[index] || '');
    filled += 1;
  }
  return { ok: true, filled, message: `已填入 ${filled} 位验证码` };
}

export interface HostedErrorState {
  hasError: boolean;
  message: string;
}

const ERROR_SELECTORS = [
  '[role="alert"]',
  '[aria-live]',
  '.Alert',
  '.Error',
  '.error',
  '.FieldError',
  '[class*="error"]',
  '[class*="Error"]',
  'div',
  'span',
  'p',
].join(', ');

const ADDRESS_ERROR_PATTERN =
  /customer'?s\s+location\s+isn'?t\s+recognized|set\s+a\s+valid\s+customer\s+address|automatically\s+calculate\s+tax|valid\s+customer\s+address|无法识别.*地址|地址.*无法识别|税.*地址/i;

const CARD_DECLINED_PATTERN =
  /(?:bank\s*)?card\s+(?:was\s+)?declined|try\s+another\s+card|payment\s+method\s+was\s+declined|银行卡被拒绝|请尝试另一张卡|请尝试另一张银行卡|您的银行卡被拒绝/i;

function findFirstErrorMatch(pattern: RegExp): HostedErrorState {
  if (!isHostedCheckoutPage()) {
    return { hasError: false, message: '' };
  }
  const seen = new Set<Element>();
  for (const element of Array.from(document.querySelectorAll(ERROR_SELECTORS))) {
    if (!element || seen.has(element) || !isVisibleElement(element)) {
      continue;
    }
    seen.add(element);
    const text = normalizeText(element.textContent || '');
    if (text && pattern.test(text)) {
      return { hasError: true, message: text.slice(0, 240) };
    }
  }
  return { hasError: false, message: '' };
}

export function getAddressErrorState(): HostedErrorState {
  return findFirstErrorMatch(ADDRESS_ERROR_PATTERN);
}

export function getCardDeclinedState(): HostedErrorState {
  return findFirstErrorMatch(CARD_DECLINED_PATTERN);
}

export interface CheckoutAmountSummary {
  hasTodayDue: boolean;
  amount: number | null;
  isZero: boolean;
  rawAmount: string;
  labelText: string;
}

const EMPTY_AMOUNT: CheckoutAmountSummary = {
  hasTodayDue: false,
  amount: null,
  isZero: false,
  rawAmount: '',
  labelText: '',
};

function parseLocalizedAmount(rawValue: string): { amount: number; raw: string } | null {
  const raw = String(rawValue || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(
    /(?:[$€£¥]\s*)?([+-]?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|[+-]?\d+(?:[.,]\d{1,2})?)(?:\s*[$€£¥])?/,
  );
  if (!match) return null;
  let numericText = String(match[1] || '').trim();
  const lastComma = numericText.lastIndexOf(',');
  const lastDot = numericText.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    numericText = numericText
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (lastComma > -1) {
    numericText = numericText.replace(',', '.');
  }
  const amount = Number(numericText.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(amount) ? { amount, raw: match[0] } : null;
}

function getTextAfterTodayDueLabel(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /(?:今日应付金额|今日应付|今天应付|amount\s*due\s*today|due\s*today|today'?s\s*total|total\s*due\s*today)/i,
  );
  if (!match) return '';
  return normalized.slice((match.index || 0) + match[0].length).trim();
}

const TOTAL_AMOUNT_SELECTORS = [
  '#OrderDetails-TotalAmount .CurrencyAmount',
  '#OrderDetails-TotalAmount',
  '#ProductSummary-totalAmount .CurrencyAmount',
  '#ProductSummary-totalAmount',
];

function getHostedCheckoutTotalAmountSummary(): CheckoutAmountSummary | null {
  if (!isHostedCheckoutPage()) {
    return null;
  }
  const seen = new Set<Element>();
  const parsedEntries: Array<{ amount: number; rawAmount: string }> = [];
  for (const selector of TOTAL_AMOUNT_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element || seen.has(element)) {
      continue;
    }
    seen.add(element);
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const parsed = parseLocalizedAmount(text);
    if (parsed) {
      parsedEntries.push({ amount: parsed.amount, rawAmount: text });
    }
  }
  if (!parsedEntries.length) {
    return null;
  }
  const nonZeroEntry = parsedEntries.find((entry) => Math.abs(entry.amount) >= 0.005) || null;
  const chosen = nonZeroEntry || parsedEntries[0];
  const isZero = parsedEntries.every((entry) => Math.abs(entry.amount) < 0.005);
  return {
    hasTodayDue: true,
    amount: chosen.amount,
    isZero,
    rawAmount: chosen.rawAmount,
    labelText: 'hosted checkout total amount',
  };
}

export function getCheckoutAmountSummary(): CheckoutAmountSummary {
  const hostedSummary = getHostedCheckoutTotalAmountSummary();
  if (hostedSummary) {
    return hostedSummary;
  }
  if (!isHostedCheckoutPage()) {
    return EMPTY_AMOUNT;
  }

  const elements = getVisibleControls('div, span, p, strong, b');
  const labelPattern =
    /今日应付金额|今日应付|今天应付|amount\s*due\s*today|due\s*today|today'?s\s*total|total\s*due\s*today/i;
  const amountPattern = /[$€£¥]\s*[+-]?\d|[+-]?\d+(?:[.,]\d{1,2})?\s*[$€£¥]/;

  for (const element of elements) {
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!labelPattern.test(text)) continue;

    const candidates: string[] = [];
    const afterLabelText = getTextAfterTodayDueLabel(text);
    if (afterLabelText) candidates.push(afterLabelText);

    const parent = element.parentElement;
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if (child === element) continue;
        const childText = String(child.textContent || '').replace(/\s+/g, ' ').trim();
        if (amountPattern.test(childText)) {
          candidates.push(childText);
        }
      }
      const parentAfter = getTextAfterTodayDueLabel(parent.textContent || '');
      if (parentAfter) candidates.push(parentAfter);
    }

    const grandparent = parent?.parentElement;
    if (grandparent) {
      const grandparentAfter = getTextAfterTodayDueLabel(grandparent.textContent || '');
      if (grandparentAfter) candidates.push(grandparentAfter);
    }

    for (const candidate of candidates) {
      const parsed = parseLocalizedAmount(candidate);
      if (parsed) {
        return {
          hasTodayDue: true,
          amount: parsed.amount,
          isZero: Math.abs(parsed.amount) < 0.005,
          rawAmount: parsed.raw,
          labelText: text.slice(0, 160),
        };
      }
    }

    return {
      hasTodayDue: true,
      amount: null,
      isZero: false,
      rawAmount: '',
      labelText: text.slice(0, 160),
    };
  }

  return EMPTY_AMOUNT;
}

export interface CardFallbackState {
  fallback: boolean;
  reason: string;
  hasPayPalButton: boolean;
  cardFieldsVisible: boolean;
}

const PAYPAL_BUTTON_SELECTORS = [
  '[data-testid="paypal-accordion-item-button"]',
  '.paypal-accordion-item button',
];

const CARD_FIELD_SELECTORS = [
  '#cardNumber',
  '#cardExpiry',
  '#cardCvc',
  'input[name="cardnumber" i]',
  'input[autocomplete="cc-number"]',
];

export function hasCreditCardFields(): boolean {
  return CARD_FIELD_SELECTORS.some((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).some(isVisibleElement));
}

export function findPayPalButton(): HTMLElement | null {
  for (const selector of PAYPAL_BUTTON_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && isVisibleElement(el)) {
      return el;
    }
  }
  return null;
}

function hasPaypalDisabledSignals(): boolean {
  return Array.from(document.querySelectorAll('iframe')).some((frame) => {
    const src = String(frame.getAttribute('src') || frame.src || '');
    return src.includes('paymentMethods][paypal]=never') || src.includes('wallets][paypal]=never');
  });
}

export function getCardFallbackState(): CardFallbackState {
  if (!isHostedCheckoutPage()) {
    return { fallback: false, reason: '', hasPayPalButton: false, cardFieldsVisible: false };
  }
  const hasPayPalButton = Boolean(findPayPalButton());
  const cardFieldsVisible = hasCreditCardFields();
  const paypalDisabledSignals = hasPaypalDisabledSignals();
  const reasons: string[] = [];
  if (!hasPayPalButton) reasons.push('未找到 PayPal 按钮');
  if (cardFieldsVisible) reasons.push('银行卡字段可见');
  if (paypalDisabledSignals) reasons.push('页面信号显示 paypal=never');
  const fallback = !hasPayPalButton && cardFieldsVisible && paypalDisabledSignals;
  return {
    fallback,
    reason: reasons.join('；'),
    hasPayPalButton,
    cardFieldsVisible,
  };
}
