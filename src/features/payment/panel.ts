import { clearFlowStop, requestFlowStop } from '../../app/dom-utils';
import type { FeaturePanelHandle } from '../../app/types';
import { PaypalFlowApi } from './paypal-flow';
import type {
  PaypalFlowState,
  PaypalHostedStage,
  PaypalStateSnapshot,
  RunHostedStepPayload,
  RunHostedStepResult,
} from './types';
import { PAYPAL_FLOW_STATE_KEY } from './types';

const STAGE_LABELS: Record<PaypalHostedStage, string> = {
  outside_paypal: '当前不在 paypal.com',
  pay_login: '登录页（输入邮箱/密码）',
  account_create_email: '新账户邮箱页（Create PayPal account）',
  guest_checkout: '游客结账页（填卡 + 地址 + 电话）',
  verification: '验证码页（6 位 OTP）',
  review_consent: 'Hermes 账单确认（Agree and Continue）',
  approval: '授权确认（Approve）',
  blocked: '已被风控（Blocked）',
  generic_error: '通用错误页',
  unknown: '未识别',
};

export function createPaymentPanel(container: HTMLElement): FeaturePanelHandle {
  container.classList.add('opx-view');
  container.innerHTML = '';

  const headerNote = document.createElement('p');
  headerNote.className = 'opx-note';
  headerNote.textContent = '面板与 paypal.com content script 共享存储。stage / 错误信息每秒刷新。';
  container.appendChild(headerNote);

  const stageBox = document.createElement('div');
  stageBox.className = 'opx-payment-stage';
  container.appendChild(stageBox);

  const errorBox = document.createElement('div');
  errorBox.className = 'opx-payment-errors';
  container.appendChild(errorBox);

  const formBlock = document.createElement('div');
  formBlock.className = 'opx-payment-form';
  container.appendChild(formBlock);

  const emailRow = createInputRow('PayPal 邮箱 (login/account create)', 'email');
  const passwordRow = createInputRow('PayPal 密码 (login)', 'password', 'password');
  const phoneRow = createInputRow('Guest checkout 电话 (不带 +1)', 'phone');
  formBlock.append(emailRow.wrapper, passwordRow.wrapper, phoneRow.wrapper);

  const codeRow = createInputRow('6 位 OTP 验证码 (Verification stage)', 'verification', 'text');
  formBlock.append(codeRow.wrapper);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'opx-payment-buttons';

  const runStepBtn = makeButton('运行下一步', 'primary');
  const resendBtn = makeButton('重发验证码');
  const submitLoginBtn = makeButton('提交登录');
  const dismissPromptBtn = makeButton('关闭 passkey/弹窗');
  const approveBtn = makeButton('点击 Approve');
  const stopBtn = makeButton('停止', 'danger');
  const clearStopBtn = makeButton('清除停止');
  buttonRow.append(runStepBtn, resendBtn, submitLoginBtn, dismissPromptBtn, approveBtn, stopBtn, clearStopBtn);
  container.appendChild(buttonRow);

  const lastResultBox = document.createElement('pre');
  lastResultBox.className = 'opx-payment-result';
  lastResultBox.textContent = '（暂无运行结果）';
  container.appendChild(lastResultBox);

  let latestState: PaypalFlowState | null = null;

  const render = (): void => {
    const snapshot = latestState?.snapshot ?? null;
    stageBox.innerHTML = '';

    const stageLine = document.createElement('div');
    stageLine.className = 'opx-payment-stage-line';
    if (snapshot) {
      stageLine.textContent = `当前 stage：${STAGE_LABELS[snapshot.hostedStage] || snapshot.hostedStage}`;
    } else {
      stageLine.textContent = '当前 stage：尚无 snapshot（请先打开 paypal.com 上的 hosted checkout 页面）';
    }
    stageBox.appendChild(stageLine);

    if (snapshot) {
      const detail = document.createElement('div');
      detail.className = 'opx-payment-detail';
      detail.textContent =
        `URL: ${snapshot.url}\n` +
        `loginPhase: ${snapshot.loginPhase || '-'}, approveReady: ${snapshot.approveReady}, ` +
        `verifInputs: ${snapshot.verificationInputsVisible}, passkey: ${snapshot.hasPasskeyPrompt}`;
      stageBox.appendChild(detail);
    }

    errorBox.innerHTML = '';
    if (snapshot) {
      const errors: string[] = [];
      if (snapshot.hostedBlocked) errors.push(`已被 Blocked：${snapshot.hostedBlockedMessage}`);
      if (snapshot.hostedGenericError) errors.push(`通用错误：${snapshot.hostedGenericErrorMessage}`);
      if (snapshot.hostedGuestCardError) errors.push(`卡片错误：${snapshot.hostedGuestCardErrorMessage}`);
      if (snapshot.hostedGuestPhoneError) errors.push(`电话错误：${snapshot.hostedGuestPhoneErrorMessage}`);
      if (snapshot.hostedVerificationInvalidCode) errors.push(`验证码无效：${snapshot.hostedVerificationErrorText}`);
      for (const error of errors) {
        const line = document.createElement('div');
        line.className = 'opx-payment-error';
        line.textContent = error;
        errorBox.appendChild(line);
      }
    }

    if (latestState?.lastStep) {
      const { result, error, completedAt } = latestState.lastStep;
      const tail = result ? `result=${stringifyResult(result)}` : `error=${error}`;
      lastResultBox.textContent = `[${formatTime(completedAt)}] ${tail}`;
    }
  };

  const collectPayload = (overrides: Partial<RunHostedStepPayload> = {}): RunHostedStepPayload => ({
    email: emailRow.input.value.trim(),
    password: passwordRow.input.value,
    phone: phoneRow.input.value.trim(),
    verificationCode: codeRow.input.value.trim(),
    ...overrides,
  });

  const callApi = async (
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    runStepBtn.disabled = true;
    try {
      const result = await fn();
      lastResultBox.textContent = `[${formatTime(Date.now())}] ${label} ok\n${stringifyResult(result)}`;
    } catch (error) {
      lastResultBox.textContent = `[${formatTime(Date.now())}] ${label} 失败：${formatError(error)}`;
    } finally {
      runStepBtn.disabled = false;
      void loadLatestState();
    }
  };

  runStepBtn.addEventListener('click', () => {
    void callApi('runHostedCheckoutStep', () => PaypalFlowApi.runHostedCheckoutStep(collectPayload()));
  });

  resendBtn.addEventListener('click', () => {
    void callApi('resend verification code', () =>
      PaypalFlowApi.runHostedCheckoutStep(collectPayload({ resendVerificationCode: true })));
  });

  submitLoginBtn.addEventListener('click', () => {
    void callApi('submitPaypalLogin', () => PaypalFlowApi.submitPaypalLogin(collectPayload()));
  });

  dismissPromptBtn.addEventListener('click', () => {
    void callApi('dismissPaypalPrompts', () => PaypalFlowApi.dismissPaypalPrompts());
  });

  approveBtn.addEventListener('click', () => {
    void callApi('clickPaypalApprove', () => PaypalFlowApi.clickPaypalApprove());
  });

  stopBtn.addEventListener('click', () => {
    void requestFlowStop();
    lastResultBox.textContent = `[${formatTime(Date.now())}] 已请求停止当前流程`;
  });

  clearStopBtn.addEventListener('click', () => {
    void clearFlowStop();
    lastResultBox.textContent = `[${formatTime(Date.now())}] 已清除停止标记`;
  });

  const loadLatestState = async (): Promise<void> => {
    try {
      const data = await browser.storage.local.get(PAYPAL_FLOW_STATE_KEY);
      const value = (data[PAYPAL_FLOW_STATE_KEY] || null) as PaypalFlowState | null;
      latestState = value;
      render();
    } catch (error) {
      console.debug('[OPX Payment Panel] load failed', error);
    }
  };

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[PAYPAL_FLOW_STATE_KEY]) {
      latestState = (changes[PAYPAL_FLOW_STATE_KEY].newValue || null) as PaypalFlowState | null;
      render();
    }
  });

  render();
  void loadLatestState();

  return {
    async update() {
      await loadLatestState();
    },
    async onShow() {
      await loadLatestState();
    },
  };
}

interface InputRowHandle {
  wrapper: HTMLDivElement;
  input: HTMLInputElement;
}

function createInputRow(labelText: string, name: string, inputType: string = 'text'): InputRowHandle {
  const wrapper = document.createElement('div');
  wrapper.className = 'opx-payment-row';

  const label = document.createElement('label');
  label.className = 'opx-payment-label';
  label.textContent = labelText;
  wrapper.appendChild(label);

  const input = document.createElement('input');
  input.className = 'opx-payment-input';
  input.type = inputType;
  input.name = `opx-payment-${name}`;
  input.placeholder = labelText;
  input.autocomplete = 'off';
  wrapper.appendChild(input);

  return { wrapper, input };
}

type ButtonVariant = 'primary' | 'danger' | 'default';

function makeButton(text: string, variant: ButtonVariant = 'default'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `opx-btn opx-btn-${variant}`;
  button.textContent = text;
  return button;
}

function formatTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function stringifyResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '');
}

// Re-export to keep PaypalStateSnapshot type used (avoid unused warning if optimizer trims).
export type { PaypalStateSnapshot };
