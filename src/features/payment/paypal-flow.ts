import {
  dispatchClick,
  emitChange,
  FlowStoppedError,
  getVisibleControls,
  isVisibleElement,
  normalizeText,
  setNativeValue,
  sleep,
  throwIfStopped,
  waitUntil,
} from '../../app/dom-utils';
import type {
  PaypalFlowState,
  PaypalHostedStage,
  PaypalMessage,
  PaypalStateSnapshot,
  RunHostedStepPayload,
  RunHostedStepResult,
} from './types';
import { PAYPAL_FLOW_STATE_KEY } from './types';

const LOG_PREFIX = '[OPX PayPal Flow]';
const LISTENER_SENTINEL = 'data-opx-paypal-flow-listener';
const HOSTED_AUTO_RUN_SENTINEL = '__OPX_PAYPAL_HOSTED_HERMES_AUTORUN__';
const HOSTED_GUEST_SUBMIT_SENTINEL = '__OPX_PAYPAL_HOSTED_GUEST_SUBMIT__';

const STAGE_OUTSIDE: PaypalHostedStage = 'outside_paypal';
const STAGE_LOGIN: PaypalHostedStage = 'pay_login';
const STAGE_ACCOUNT_CREATE: PaypalHostedStage = 'account_create_email';
const STAGE_GUEST_CHECKOUT: PaypalHostedStage = 'guest_checkout';
const STAGE_VERIFICATION: PaypalHostedStage = 'verification';
const STAGE_REVIEW: PaypalHostedStage = 'review_consent';
const STAGE_APPROVAL: PaypalHostedStage = 'approval';
const STAGE_BLOCKED: PaypalHostedStage = 'blocked';
const STAGE_GENERIC_ERROR: PaypalHostedStage = 'generic_error';
const STAGE_UNKNOWN: PaypalHostedStage = 'unknown';

export function isPaypalSite(): boolean {
  return /(^|\.)paypal\.com$/i.test(String(location.host || ''));
}

export function initPaypalFlow(): void {
  if (!isPaypalSite()) {
    return;
  }
  installMessageListener();
  scheduleHostedHermesAutoRun();
  void refreshSnapshotStore();
  installSnapshotRefresh();
}

function installMessageListener(): void {
  const root = document.documentElement;
  if (!root || root.getAttribute(LISTENER_SENTINEL) === '1') {
    return;
  }
  root.setAttribute(LISTENER_SENTINEL, '1');

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isPaypalMessage(message)) {
      return false;
    }
    handlePaypalMessage(message).then(
      (result) => sendResponse({ ok: true, ...(result as object) }),
      (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }),
    );
    return true;
  });
}

function isPaypalMessage(value: unknown): value is PaypalMessage {
  if (!value || typeof value !== 'object') return false;
  const type = String((value as { type?: unknown }).type || '');
  return type === 'opx:paypal-hosted-get-state' ||
    type === 'opx:paypal-run-hosted-step' ||
    type === 'opx:paypal-submit-login' ||
    type === 'opx:paypal-dismiss-prompts' ||
    type === 'opx:paypal-click-approve';
}

async function handlePaypalMessage(message: PaypalMessage): Promise<object> {
  try {
    switch (message.type) {
      case 'opx:paypal-hosted-get-state':
        return inspectAndPersist();
      case 'opx:paypal-run-hosted-step':
        return await runHostedAndPersist(message.payload || {});
      case 'opx:paypal-submit-login':
        return await submitPaypalLogin(message.payload || {});
      case 'opx:paypal-dismiss-prompts':
        return await dismissPaypalPrompts();
      case 'opx:paypal-click-approve':
        return await clickPaypalApprove();
    }
  } catch (error) {
    if (error instanceof FlowStoppedError) {
      return { stopped: true, error: error.message };
    }
    throw error;
  }
  return {};
}

async function refreshSnapshotStore(): Promise<void> {
  try {
    inspectAndPersist();
  } catch (error) {
    console.debug(LOG_PREFIX, 'snapshot refresh skipped', error);
  }
}

function installSnapshotRefresh(): void {
  let timer: number | null = null;
  const schedule = () => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      void refreshSnapshotStore();
    }, 800);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
}

function inspectAndPersist(): PaypalStateSnapshot {
  const snapshot = inspectPaypalState();
  void persistSnapshot(snapshot);
  return snapshot;
}

async function runHostedAndPersist(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  const requestedAt = Date.now();
  let result: RunHostedStepResult | null = null;
  let errorText = '';
  try {
    result = await runHostedCheckoutStep(payload);
    return result;
  } catch (error) {
    errorText = errorMessage(error);
    throw error;
  } finally {
    const snapshot = inspectPaypalState();
    void persistSnapshot(snapshot, {
      lastStep: {
        requestedAt,
        completedAt: Date.now(),
        payload,
        result,
        error: errorText,
      },
    });
  }
}

async function persistSnapshot(
  snapshot: PaypalStateSnapshot,
  extras: Partial<PaypalFlowState> = {},
): Promise<void> {
  try {
    const current = await browser.storage.local.get(PAYPAL_FLOW_STATE_KEY);
    const existing = (current[PAYPAL_FLOW_STATE_KEY] || {}) as Partial<PaypalFlowState>;
    const next: PaypalFlowState = {
      snapshot,
      lastStep: extras.lastStep ?? existing.lastStep ?? null,
      storedEmail: String(existing.storedEmail || ''),
      storedPassword: String(existing.storedPassword || ''),
      storedPhone: String(existing.storedPhone || ''),
      updatedAt: Date.now(),
    };
    await browser.storage.local.set({ [PAYPAL_FLOW_STATE_KEY]: next });
  } catch (error) {
    console.debug(LOG_PREFIX, 'persistSnapshot failed', error);
  }
}

export async function runHostedCheckoutStep(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  const stage = detectPayPalHostedCheckoutStage();
  if (payload.resendVerificationCode && stage !== STAGE_VERIFICATION) {
    return { stage, submitted: false, resendSkipped: true };
  }
  if (isReviewPage()) {
    return clickHostedReviewConsent();
  }
  if (stage === STAGE_VERIFICATION) {
    if (payload.resendVerificationCode) {
      return clickHostedVerificationResend();
    }
    if (!payload.verificationCode && !payload.code) {
      return { stage, requiresVerificationCode: true };
    }
    return fillHostedVerificationCode(payload);
  }
  if (stage === STAGE_LOGIN) {
    return submitHostedPayLogin(payload);
  }
  if (stage === STAGE_ACCOUNT_CREATE) {
    return submitHostedAccountCreateEmail(payload);
  }
  if (stage === STAGE_GUEST_CHECKOUT) {
    return fillHostedGuestCheckout(payload);
  }
  if (stage === STAGE_REVIEW) {
    return clickHostedReviewConsent();
  }
  return {
    stage,
    submitted: false,
    approveReady: Boolean(findApproveButton()),
  };
}

export function detectPayPalHostedCheckoutStage(): PaypalHostedStage {
  if (!isPaypalSite()) return STAGE_OUTSIDE;
  if (hasHostedVerificationInputs()) return STAGE_VERIFICATION;
  if (isBlockedPage()) return STAGE_BLOCKED;
  if (isGenericErrorPage()) return STAGE_GENERIC_ERROR;
  if (isAccountCreateEmailPage()) return STAGE_ACCOUNT_CREATE;
  if (isGuestCheckoutPage()) return STAGE_GUEST_CHECKOUT;
  if (isReviewPage() && findHostedReviewConsentButton()) return STAGE_REVIEW;
  if (isLoginPage()) return STAGE_LOGIN;
  if (findApproveButton()) return STAGE_APPROVAL;
  return STAGE_UNKNOWN;
}

function getPathname(): string {
  return String(location.pathname || '').trim();
}

function isLoginPage(): boolean {
  const pathname = getPathname();
  return pathname === '/pay' || Boolean(document.getElementById('email'));
}

function isAccountCreateEmailPage(): boolean {
  const bodyText = bodyInnerText();
  const emailInput = document.getElementById('email') as HTMLInputElement | null || findEmailInput();
  const hasCardOrAddressForm = Boolean(
    document.getElementById('cardNumber') ||
    document.getElementById('billingLine1') ||
    document.getElementById('cardExpiry') ||
    document.getElementById('cardCvv'),
  );
  return Boolean(emailInput) &&
    !findPasswordInput() &&
    !hasCardOrAddressForm &&
    Boolean(findAccountCreateContinueButton()) &&
    (
      /创建\s*PayPal\s*账户|create\s+(?:a\s+)?paypal\s+account/i.test(bodyText) ||
      /您已有账号了吗|already\s+have\s+an?\s+account/i.test(bodyText)
    );
}

function isGuestCheckoutPage(): boolean {
  return /\/checkoutweb\//i.test(getPathname()) ||
    Boolean(document.getElementById('cardNumber')) ||
    Boolean(document.getElementById('billingLine1'));
}

function isReviewPage(): boolean {
  return /\/webapps\/hermes/i.test(getPathname());
}

function isBlockedPage(): boolean {
  const bodyText = bodyInnerText();
  return Boolean(getBlockedMessage()) ||
    (/you\s+have\s+been\s+blocked/i.test(bodyText) && /security\s+challenge/i.test(bodyText));
}

function isGenericErrorPage(): boolean {
  const pathname = getPathname();
  const bodyText = bodyInnerText();
  return /\/checkoutweb\/genericError/i.test(pathname) ||
    Boolean(getGenericErrorMessage()) ||
    (/(?:sorry,\s*)?something\s+went\s+wrong/i.test(bodyText) && /return\s+to\s+merchant/i.test(bodyText)) ||
    (/paypal\s+isn[’']?t\s+available\s+at\s+this\s+time/i.test(bodyText) && /choose\s+another\s+way\s+to\s+pay/i.test(bodyText));
}

function bodyInnerText(): string {
  return normalizePlain(document.body?.innerText || '');
}

function normalizePlain(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function getBlockedMessage(): string {
  const bodyText = bodyInnerText();
  const match = bodyText.match(/You\s+have\s+been\s+blocked\.?|We\s+couldn[’']?t\s+load\s+the\s+security\s+challenge\.?/i);
  return match ? match[0] : '';
}

export function getGenericErrorMessage(): string {
  const bodyText = bodyInnerText();
  const match = bodyText.match(
    /Things\s+don[’']?t\s+appear\s+to\s+be\s+working\s+at\s+the\s+moment\.?|Sorry,\s*something\s+went\s+wrong\.?\s*Please\s+try\s+again\.?|Something\s+went\s+wrong/i,
  );
  return match ? match[0] : '';
}

export function getGuestCardErrorMessage(): string {
  const bodyText = bodyInnerText();
  const match = bodyText.match(
    /We\s+weren[’']?t\s+able\s+to\s+add\s+this\s+card\.?\s*Check\s+all\s+the\s+details\s+are\s+correct\s+and\s+try\s+again\s+or\s+try\s+a\s+different\s+card\.?|无法添加此卡|无法新增此卡|请检查所有详细信息是否正确.*(?:其他|不同).*卡/i,
  );
  return match ? match[0] : '';
}

export function getGuestPhoneErrorMessage(): string {
  const bodyText = bodyInnerText();
  const match = bodyText.match(
    /We[’']?re\s+unable\s+to\s+complete\s+your\s+request\.?\s*Try\s+a\s+different\s+phone\s+number\.?|Try\s+a\s+different\s+phone\s+number\.?|请尝试其他手机号|请更换手机号/i,
  );
  return match ? match[0] : '';
}

function findHostedVerificationInputs(): HTMLInputElement[] {
  return Array.from({ length: 6 }, (_, index) => document.getElementById(`ci-ciBasic-${index}`))
    .filter((input): input is HTMLInputElement => isVisibleElement(input));
}

function hasHostedVerificationInputs(): boolean {
  return findHostedVerificationInputs().length >= 6;
}

function getHostedVerificationErrorText(): string {
  const errorPattern = /check\s+the\s+code\s+and\s+try\s+again|(?:sorry,\s*)?something\s+went\s+wrong\.?\s*get\s+a\s+new\s+code|get\s+a\s+new\s+code/i;
  const alert = document.getElementById('message_ciBasic') ||
    getVisibleControls('[role="alert"]').find((node) => errorPattern.test(normalizePlain(node.textContent || '')));
  return alert && isVisibleElement(alert) ? normalizePlain(alert.textContent || '') : '';
}

function hasHostedInvalidVerificationCodeError(): boolean {
  return /check\s+the\s+code\s+and\s+try\s+again|(?:sorry,\s*)?something\s+went\s+wrong\.?\s*get\s+a\s+new\s+code|get\s+a\s+new\s+code/i.test(
    getHostedVerificationErrorText(),
  );
}

function findHostedVerificationResendButton(): HTMLElement | null {
  const direct = document.querySelector<HTMLElement>('button[data-testid="resend-link"]');
  if (direct && isVisibleElement(direct) && isEnabledControl(direct)) {
    return direct;
  }
  return findClickableByText([/resend/i, /重新发送|重发/i]);
}

function findHostedReviewConsentButton(): HTMLElement | null {
  const direct = document.getElementById('consentButton') as HTMLElement | null ||
    document.querySelector<HTMLElement>('button[data-testid="consentButton"]');
  if (direct && isVisibleElement(direct) && isEnabledControl(direct)) {
    return direct;
  }
  return findClickableByText([
    /agree\s*(?:and)?\s*continue|accept|continue/i,
    /同意并继续|同意|继续/i,
  ]);
}

function findAccountCreateContinueButton(): HTMLElement | null {
  return findClickableByText([
    /continue\s+(?:to\s+)?pay(?:ment)?/i,
    /继续付款|继续支付/i,
  ]);
}

function findLoginNextButton(): HTMLElement | null {
  return findClickableByText([
    /next|continue|login|log\s*in|sign\s*in/i,
    /下一步|继续|登录|登入/i,
  ]);
}

function findEmailNextButton(): HTMLElement | null {
  return findClickableByText([
    /next|btn\s*next|btnnext/i,
    /下一页|下一步/i,
  ]);
}

function findPasswordLoginButton(): HTMLElement | null {
  const button = findClickableByText([
    /login|log\s*in|sign\s*in/i,
    /登录|登入/i,
  ]);
  return button && button !== findEmailNextButton() ? button : null;
}

function findApproveButton(): HTMLElement | null {
  return findClickableByText([
    /同意并继续|同意|继续|授权|确认并继续/i,
    /agree\s*(?:and)?\s*continue|continue|accept|authorize|agree|pay\s*now/i,
  ]);
}

function findEmailInput(): HTMLInputElement | null {
  const inputs = getVisibleControls<HTMLInputElement>('input').filter((input) => {
    const type = String(input.getAttribute('type') || input.type || '').toLowerCase();
    return isEnabledControl(input) &&
      !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(type) &&
      !isPasswordCandidate(input);
  });
  const byHint = inputs.find((input) => /email|login|user|账号|邮箱/i.test(getActionText(input)));
  if (byHint) return byHint;
  const byType = getVisibleControls<HTMLInputElement>('input[type="email"]').find((input) => !isPasswordCandidate(input));
  return byType || null;
}

function findPasswordInput(): HTMLInputElement | null {
  const inputs = getVisibleControls<HTMLInputElement>('input').filter((input) => {
    const type = String(input.getAttribute('type') || input.type || '').toLowerCase();
    return isEnabledControl(input) &&
      !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(type);
  });
  const byHintOrType = inputs.find((input) => {
    const type = String(input.getAttribute('type') || input.type || '').toLowerCase();
    return type === 'password' || /password|pass|密码/i.test(getActionText(input));
  });
  return byHintOrType || getVisibleControls<HTMLInputElement>('input[type="password"]').find(isVisibleElement) || null;
}

function isPasswordCandidate(input: HTMLInputElement): boolean {
  const type = String(input.getAttribute('type') || input.type || '').toLowerCase();
  return type === 'password' || /password|pass|密码/i.test(getActionText(input));
}

function isEnabledControl(element: Element | null): boolean {
  if (!element) return false;
  const html = element as HTMLInputElement;
  return !html.disabled && html.getAttribute('aria-disabled') !== 'true';
}

function getActionText(element: Element | null): string {
  if (!element) return '';
  const html = element as HTMLElement;
  return normalizePlain([
    html.textContent,
    (html as HTMLInputElement).value,
    html.getAttribute('aria-label'),
    html.getAttribute('title'),
    html.getAttribute('placeholder'),
    html.getAttribute('name'),
    html.id,
  ].filter(Boolean).join(' '));
}

type TextPattern = RegExp;

function findClickableByText(patterns: TextPattern[]): HTMLElement | null {
  const candidates = getVisibleControls<HTMLElement>(
    'button, a, [role="button"], input[type="button"], input[type="submit"]',
  );
  return candidates.find((el) => patterns.some((pattern) => pattern.test(getActionText(el)))) || null;
}

function fillHostedInputById(id: string, value: string): boolean {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input || !isVisibleElement(input) || !isEnabledControl(input)) {
    return false;
  }
  setNativeValue(input, String(value || ''));
  return true;
}

function selectHostedOptionByIdText(id: string, text: string): boolean {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  const expected = String(text || '').trim().toLowerCase();
  if (!select || !expected) return false;
  const match = Array.from(select.options || []).find((option) => {
    const label = String(option.textContent || option.label || '').trim().toLowerCase();
    const value = String(option.value || '').trim().toLowerCase();
    return label.includes(expected) || value.includes(expected);
  });
  if (!match) return false;
  select.value = match.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function refillEmailInput(input: HTMLInputElement, email: string): void {
  if (typeof input.focus === 'function') {
    input.focus();
  }
  setNativeValue(input, '');
  setNativeValue(input, email);
  if (typeof input.blur === 'function') {
    input.blur();
  }
}

function removeCaptchaArtifacts(): boolean {
  let removed = false;
  for (const selector of ['#captcha-standalone', '.captcha-overlay', '.captcha-container']) {
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

function startCaptchaCleanupObserver(timeoutMs = 15000): void {
  const observer = new MutationObserver(() => removeCaptchaArtifacts());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
  window.setTimeout(() => observer.disconnect(), Math.max(1000, timeoutMs));
}

async function waitForDocumentComplete(): Promise<void> {
  await waitUntil(() => document.readyState === 'complete', { intervalMs: 200, timeout: 30000 });
  await sleep(1000);
}

function dispatchHostedGenericClick(button: HTMLElement): void {
  const rect = button.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const eventInit: PointerEventInit & MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
  };
  button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
  button.dispatchEvent(new MouseEvent('mousedown', eventInit));
  button.dispatchEvent(new PointerEvent('pointerup', eventInit));
  button.dispatchEvent(new MouseEvent('mouseup', eventInit));
  button.dispatchEvent(new MouseEvent('click', eventInit));
}

interface ClickHostedResult {
  clicked: boolean;
  verificationRequired: boolean;
  buttonText: string;
  retried?: boolean;
}

function findHostedGuestSubmitButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('button[data-testid="submit-button"]') ||
    document.querySelector<HTMLElement>('button[data-testid="hosted-payment-submit-button"]') ||
    document.querySelector<HTMLElement>('button[data-atomic-wait-intent="Submit_Email"]') ||
    document.querySelector<HTMLElement>('button.SubmitButton--complete') ||
    findClickableByText([
      /pay|continue|next|agree|subscribe/i,
      /支付|继续|下一步|同意|订阅/i,
    ]);
}

async function clickHostedGenericSubmitButton(retries = 0): Promise<ClickHostedResult> {
  throwIfStopped();
  removeCaptchaArtifacts();
  const button = findHostedGuestSubmitButton() || findEmailNextButton() || findLoginNextButton();
  if (!button) {
    if (retries >= 10) {
      throw new Error('PayPal hosted checkout 未找到可点击的继续/提交按钮');
    }
    await sleep(1000);
    return clickHostedGenericSubmitButton(retries + 1);
  }

  const buttonText = normalizePlain(button.textContent || '');
  if ((button as HTMLButtonElement).disabled) {
    if (retries >= 10) {
      throw new Error('PayPal hosted checkout 按钮长时间处于 disabled 状态');
    }
    await sleep(1000);
    return clickHostedGenericSubmitButton(retries + 1);
  }

  const rect = button.getBoundingClientRect();
  if (rect.height === 0) {
    if (retries >= 10) {
      throw new Error('PayPal hosted checkout 按钮长时间不可见');
    }
    await sleep(1000);
    return clickHostedGenericSubmitButton(retries + 1);
  }

  dispatchHostedGenericClick(button);
  await sleep(1000);
  removeCaptchaArtifacts();

  if (hasHostedVerificationInputs()) {
    return { clicked: true, verificationRequired: true, buttonText };
  }

  const currentText = normalizePlain(button.textContent || '');
  if (!/processing/i.test(currentText) && currentText === buttonText) {
    if (retries >= 10) {
      return { clicked: true, verificationRequired: false, buttonText, retried: true };
    }
    await sleep(2000);
    return clickHostedGenericSubmitButton(retries + 1);
  }

  return { clicked: true, verificationRequired: false, buttonText };
}

function buildRandomEmail(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 16; i += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${value}@gmail.com`;
}

function buildRandomPassword(): string {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^';
  const alphabet = `${lowercase}${uppercase}${digits}${symbols}`;
  const value: string[] = [
    lowercase[Math.floor(Math.random() * lowercase.length)],
    uppercase[Math.floor(Math.random() * uppercase.length)],
    digits[Math.floor(Math.random() * digits.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];
  while (value.length < 14) {
    value.push(alphabet[Math.floor(Math.random() * alphabet.length)]);
  }
  return value.sort(() => Math.random() - 0.5).join('');
}

function buildVisaCard(): { number: string; expiry: string; cvv: string } {
  const prefixes: number[][] = [
    [4, 1, 4, 7],
    [4, 1, 0, 0],
  ];
  const digits = prefixes[Math.floor(Math.random() * prefixes.length)].slice();
  while (digits.length < 15) {
    digits.push(Math.floor(Math.random() * 10));
  }
  const reversed = digits.slice().reverse();
  let sum = 0;
  for (let i = 0; i < reversed.length; i += 1) {
    let digit = reversed[i];
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  digits.push((10 - (sum % 10)) % 10);
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const currentYear = new Date().getFullYear() % 100;
  const year = currentYear + Math.floor(Math.random() * 4) + 2;
  const cvv = String(Math.floor(100 + Math.random() * 900));
  return {
    number: digits.join(''),
    expiry: `${month} / ${year}`,
    cvv,
  };
}

function normalizeVerificationCode(value: string): string {
  return String(value || '').replace(/\D+/g, '').slice(0, 6);
}

async function submitHostedPayLogin(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  removeCaptchaArtifacts();
  const email = normalizePlain(payload.email || buildRandomEmail());
  if (!email) {
    throw new Error('PayPal hosted checkout 缺少邮箱');
  }
  const emailInput = (document.getElementById('email') as HTMLInputElement | null) || findEmailInput();
  if (!emailInput) {
    throw new Error('PayPal hosted checkout 未找到邮箱输入框');
  }
  await sleep(2000);
  refillEmailInput(emailInput, email);
  await sleep(1000);
  const clickResult = await clickHostedGenericSubmitButton(0);
  return {
    stage: STAGE_LOGIN,
    submitted: true,
    generatedEmail: email,
    verificationRequired: Boolean(clickResult.verificationRequired),
    nextExpected: 'guest_checkout_or_verification',
  };
}

async function submitHostedAccountCreateEmail(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  removeCaptchaArtifacts();
  const email = normalizePlain(payload.email || buildRandomEmail());
  if (!email) {
    throw new Error('PayPal 创建账户页缺少邮箱');
  }
  const emailInput = (document.getElementById('email') as HTMLInputElement | null) || findEmailInput();
  if (!emailInput) {
    throw new Error('PayPal 创建账户页未找到邮箱输入框');
  }
  await sleep(1000);
  refillEmailInput(emailInput, email);
  await sleep(500);
  const button = findAccountCreateContinueButton();
  if (button && isVisibleElement(button) && isEnabledControl(button)) {
    dispatchHostedGenericClick(button);
    await sleep(1000);
    removeCaptchaArtifacts();
  } else {
    await clickHostedGenericSubmitButton(0);
  }
  return {
    stage: STAGE_ACCOUNT_CREATE,
    submitted: true,
    generatedEmail: email,
    nextExpected: 'guest_checkout_or_verification',
  };
}

async function fillHostedVerificationCode(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  const code = normalizeVerificationCode(payload.verificationCode || payload.code || '');
  if (code.length !== 6) {
    throw new Error('PayPal hosted checkout 验证码必须是 6 位数字');
  }
  const inputs = findHostedVerificationInputs();
  if (inputs.length < 6) {
    throw new Error('PayPal hosted checkout 当前页面未显示验证码输入框');
  }
  inputs.forEach((input, index) => {
    setNativeValue(input, code[index] || '');
  });
  return {
    stage: STAGE_VERIFICATION,
    codeSubmitted: true,
  };
}

async function clickHostedVerificationResend(): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  const button = await waitUntil<HTMLElement>(
    () => findHostedVerificationResendButton(),
    {
      intervalMs: 250,
      timeout: 10000,
    },
  );
  dispatchClick(button);
  return {
    stage: STAGE_VERIFICATION,
    resendClicked: true,
    invalidCodeVisibleAfterClick: hasHostedInvalidVerificationCodeError(),
  };
}

async function fillHostedGuestCheckout(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  startCaptchaCleanupObserver();
  removeCaptchaArtifacts();

  await sleep(2000);
  const countrySelect = document.getElementById('country') as HTMLSelectElement | null;
  if (countrySelect && String(countrySelect.value || '').trim().toUpperCase() !== 'US') {
    countrySelect.value = 'US';
    countrySelect.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(3000);
  }

  const card = buildVisaCard();
  const email = normalizePlain(payload.email || buildRandomEmail());
  const phone = normalizePlain(payload.phone || '');
  const password = String(payload.password || buildRandomPassword());
  const firstName = normalizePlain(payload.firstName || 'James');
  const lastName = normalizePlain(payload.lastName || 'Smith');
  const cardNumber = String(payload.cardNumber || card.number).replace(/\s+/g, '');
  const cardExpiry = normalizePlain(payload.cardExpiry || card.expiry);
  const cardCvv = normalizePlain(payload.cardCvv || card.cvv);
  const address = payload.address && typeof payload.address === 'object' ? payload.address : {};

  if (!email || !phone || !password || !cardNumber || !cardExpiry || !cardCvv) {
    throw new Error('PayPal hosted checkout 缺少卡支付所需资料（请先在面板填写 PayPal 电话，不带 +1）');
  }

  fillHostedInputById('email', email);
  fillHostedInputById('phone', phone);
  fillHostedInputById('cardNumber', cardNumber);
  fillHostedInputById('cardExpiry', cardExpiry);
  fillHostedInputById('cardCvv', cardCvv);
  fillHostedInputById('password', password);
  fillHostedInputById('firstName', firstName);
  fillHostedInputById('lastName', lastName);
  fillHostedInputById('billingLine1', address.street || '');
  fillHostedInputById('billingCity', address.city || '');
  fillHostedInputById('billingPostalCode', address.zip || '');
  selectHostedOptionByIdText('billingState', address.state || '');

  const rootScope = window as unknown as Record<string, unknown>;
  if (!rootScope[HOSTED_GUEST_SUBMIT_SENTINEL]) {
    rootScope[HOSTED_GUEST_SUBMIT_SENTINEL] = true;
    window.setTimeout(() => {
      try {
        throwIfStopped();
      } catch {
        rootScope[HOSTED_GUEST_SUBMIT_SENTINEL] = false;
        return;
      }
      clickHostedGenericSubmitButton(0)
        .catch((error) => console.warn(LOG_PREFIX, 'guest submit failed', error))
        .finally(() => {
          rootScope[HOSTED_GUEST_SUBMIT_SENTINEL] = false;
        });
    }, 500);
  }

  return {
    stage: STAGE_GUEST_CHECKOUT,
    submitted: true,
    verificationRequired: hasHostedVerificationInputs(),
    submitScheduled: true,
  };
}

async function clickHostedReviewConsent(): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  console.info(LOG_PREFIX, 'PayPal Hermes：开始等待账单确认文案', location.href);
  let waited = 0;
  while (waited < 30) {
    waited += 1;
    const pageText = document.body ? document.body.innerText : '';
    if (String(pageText || '').includes('Set up once. Pay faster next time')) {
      let button = document.getElementById('consentButton') as HTMLElement | null ||
        document.querySelector<HTMLElement>('button[data-testid="consentButton"]');
      if (button) {
        emitChange(button);
        button.click();
        return { stage: STAGE_REVIEW, submitted: true };
      }
      await sleep(2000);
      button = document.getElementById('consentButton') as HTMLElement | null;
      if (button) {
        button.click();
        return { stage: STAGE_REVIEW, submitted: true };
      }
      throw new Error('PayPal hosted checkout 未找到 consentButton');
    }
    await sleep(1000);
  }
  throw new Error('PayPal hosted checkout 账单确认页超时，未检测到目标文案');
}

function shouldAutoRunHostedHermesReview(): boolean {
  const rootScope = window as unknown as Record<string, unknown>;
  if (!isReviewPage()) return false;
  if (rootScope[HOSTED_AUTO_RUN_SENTINEL]) return false;
  rootScope[HOSTED_AUTO_RUN_SENTINEL] = true;
  return true;
}

function scheduleHostedHermesAutoRun(): void {
  if (!shouldAutoRunHostedHermesReview()) {
    return;
  }
  console.info(LOG_PREFIX, 'PayPal Hermes：自动等待并点击 Agree and Continue', location.href);
  window.setTimeout(() => {
    clickHostedReviewConsent()
      .then(() => console.info(LOG_PREFIX, 'PayPal Hermes：已自动点击 Agree and Continue'))
      .catch((error) => console.warn(LOG_PREFIX, 'PayPal Hermes：自动点击失败', error));
  }, 0);
}

function findPasskeyPromptButtons(): HTMLElement[] {
  const promptPatterns = [/passkey|通行密钥|安全密钥|下次登录|faster|save/i];
  const bodyText = bodyInnerText();
  const likely = promptPatterns.some((pattern) => pattern.test(bodyText));
  if (!likely) return [];

  const cancelOrClose = getVisibleControls<HTMLElement>('button, a, [role="button"]').filter((el) => {
    const text = getActionText(el);
    const ariaLabel = el.getAttribute('aria-label') || '';
    return /取消|稍后|不保存|不用|关闭|cancel|not now|maybe later|skip|close|x/i.test(text) ||
      /close|关闭/i.test(ariaLabel);
  });

  const iconCloseButtons = getVisibleControls<HTMLElement>('button, [role="button"]').filter((el) => {
    const text = getActionText(el);
    const rect = el.getBoundingClientRect();
    return (/^×$|^x$/i.test(text) || /close|关闭/i.test(text)) && rect.width <= 64 && rect.height <= 64;
  });

  return [...cancelOrClose, ...iconCloseButtons];
}

function hasPasskeyPrompt(): boolean {
  return findPasskeyPromptButtons().length > 0;
}

function getLoginPhase(
  emailInput: HTMLInputElement | null,
  passwordInput: HTMLInputElement | null,
): PaypalStateSnapshot['loginPhase'] {
  const emailNextButton = findEmailNextButton();
  const passwordLoginButton = findPasswordLoginButton();
  if (emailInput && emailNextButton && isEnabledControl(emailNextButton) && (!passwordInput || !passwordLoginButton)) {
    return 'email';
  }
  if (emailInput && passwordInput) return 'login_combined';
  if (passwordInput) return 'password';
  if (emailInput) return 'email';
  return '';
}

async function submitPaypalLogin(payload: RunHostedStepPayload): Promise<RunHostedStepResult> {
  await waitForDocumentComplete();
  const email = normalizePlain(payload.email || '');
  const password = String(payload.password || '');
  if (!password) {
    throw new Error('PayPal 密码为空，请先在面板配置');
  }

  let passwordInput = findPasswordInput();
  const emailInput = findEmailInput();
  const emailNextButton = findEmailNextButton();

  if (emailInput && emailNextButton && isEnabledControl(emailNextButton) && (!passwordInput || !findPasswordLoginButton())) {
    refillEmailInput(emailInput, email);
    dispatchClick(emailNextButton);
    return { stage: STAGE_LOGIN, submitted: false, nextExpected: 'password_page' };
  }

  if (!passwordInput && emailInput && email) {
    refillEmailInput(emailInput, email);
    const nextButton = await waitUntil<HTMLElement>(
      () => {
        const btn = findEmailNextButton() || findLoginNextButton();
        return btn && isEnabledControl(btn) ? btn : null;
      },
      { intervalMs: 250, timeout: 8000 },
    );
    dispatchClick(nextButton);
    return { stage: STAGE_LOGIN, submitted: false, nextExpected: 'password_page' };
  } else if (!passwordInput && emailInput && !email) {
    throw new Error('PayPal 账号为空，请先在面板配置');
  } else if (emailInput && email) {
    refillEmailInput(emailInput, email);
  }

  passwordInput = passwordInput || await waitUntil<HTMLInputElement>(
    () => findPasswordInput(),
    { intervalMs: 250, timeout: 8000 },
  );
  setNativeValue(passwordInput, password);
  await sleep(1000);

  const loginButton = await waitUntil<HTMLElement>(
    () => {
      const btn = findClickableByText([
        /login|log\s*in|sign\s*in|continue/i,
        /登录|登入|继续/i,
      ]);
      return btn && isEnabledControl(btn) ? btn : null;
    },
    { intervalMs: 250, timeout: 8000 },
  );
  dispatchClick(loginButton);
  return { stage: STAGE_LOGIN, submitted: true, nextExpected: 'redirect_or_approval' };
}

async function dismissPaypalPrompts(): Promise<{ clicked: number; hasPromptAfterClick: boolean }> {
  await waitForDocumentComplete();
  const buttons = findPasskeyPromptButtons();
  let clicked = 0;
  for (const button of buttons) {
    if (!isVisibleElement(button) || !isEnabledControl(button)) continue;
    dispatchClick(button);
    clicked += 1;
    await sleep(500);
  }
  return { clicked, hasPromptAfterClick: hasPasskeyPrompt() };
}

async function clickPaypalApprove(): Promise<{ clicked: boolean; buttonText?: string; state?: PaypalStateSnapshot }> {
  await waitForDocumentComplete();
  await dismissPaypalPrompts().catch(() => ({ clicked: 0, hasPromptAfterClick: false }));

  const button = findApproveButton();
  if (!button || !isEnabledControl(button)) {
    return { clicked: false, state: inspectPaypalState() };
  }
  dispatchClick(button);
  return { clicked: true, buttonText: getActionText(button) };
}

export function inspectPaypalState(): PaypalStateSnapshot {
  const emailInput = findEmailInput();
  const passwordInput = findPasswordInput();
  const approveButton = findApproveButton();
  const loginPhase = getLoginPhase(emailInput, passwordInput);
  const hostedStage = detectPayPalHostedCheckoutStage();
  return {
    url: location.href,
    readyState: document.readyState,
    hostedStage,
    needsLogin: Boolean(loginPhase),
    loginPhase,
    hasEmailInput: Boolean(emailInput),
    hasPasswordInput: Boolean(passwordInput),
    hostedAccountCreateEmail: hostedStage === STAGE_ACCOUNT_CREATE,
    hostedAccountCreateEmailContinueReady: Boolean(findAccountCreateContinueButton()),
    hasHostedGuestCheckout: hostedStage === STAGE_GUEST_CHECKOUT,
    hostedBlocked: hostedStage === STAGE_BLOCKED,
    hostedBlockedMessage: getBlockedMessage(),
    hostedGenericError: hostedStage === STAGE_GENERIC_ERROR,
    hostedGenericErrorMessage: getGenericErrorMessage(),
    hostedGuestCardError: Boolean(getGuestCardErrorMessage()),
    hostedGuestCardErrorMessage: getGuestCardErrorMessage(),
    hostedGuestPhoneError: Boolean(getGuestPhoneErrorMessage()),
    hostedGuestPhoneErrorMessage: getGuestPhoneErrorMessage(),
    verificationInputsVisible: hasHostedVerificationInputs(),
    hostedVerificationInvalidCode: hasHostedInvalidVerificationCodeError(),
    hostedVerificationErrorText: getHostedVerificationErrorText(),
    hostedVerificationResendReady: Boolean(findHostedVerificationResendButton()),
    reviewConsentReady: Boolean(findHostedReviewConsentButton()),
    approveReady: Boolean(approveButton && isEnabledControl(approveButton)),
    approveButtonText: approveButton ? getActionText(approveButton) : '',
    hasPasskeyPrompt: hasPasskeyPrompt(),
    bodyTextPreview: bodyInnerText().slice(0, 240),
    fetchedAt: Date.now(),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '');
}

// Re-export panel-callable helpers
export const PaypalFlowApi = {
  inspectPaypalState,
  runHostedCheckoutStep,
  submitPaypalLogin,
  dismissPaypalPrompts,
  clickPaypalApprove,
};
