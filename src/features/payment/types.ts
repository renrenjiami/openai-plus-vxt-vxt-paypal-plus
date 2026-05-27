export type PaypalHostedStage =
  | 'outside_paypal'
  | 'pay_login'
  | 'account_create_email'
  | 'guest_checkout'
  | 'verification'
  | 'review_consent'
  | 'approval'
  | 'blocked'
  | 'generic_error'
  | 'unknown';

export interface PaypalAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface RunHostedStepPayload {
  email?: string;
  password?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  address?: PaypalAddress;
  verificationCode?: string;
  code?: string;
  resendVerificationCode?: boolean;
  cardNumber?: string;
  cardExpiry?: string;
  cardCvv?: string;
}

export interface RunHostedStepResult {
  stage: PaypalHostedStage;
  submitted?: boolean;
  requiresVerificationCode?: boolean;
  verificationRequired?: boolean;
  generatedEmail?: string;
  approveReady?: boolean;
  resendSkipped?: boolean;
  resendClicked?: boolean;
  invalidCodeVisibleAfterClick?: boolean;
  codeSubmitted?: boolean;
  buttonText?: string;
  submitScheduled?: boolean;
  nextExpected?: string;
  error?: string;
}

export interface PaypalStateSnapshot {
  url: string;
  readyState: string;
  hostedStage: PaypalHostedStage;
  needsLogin: boolean;
  loginPhase: '' | 'email' | 'password' | 'login_combined';
  hasEmailInput: boolean;
  hasPasswordInput: boolean;
  hostedAccountCreateEmail: boolean;
  hostedAccountCreateEmailContinueReady: boolean;
  hasHostedGuestCheckout: boolean;
  hostedBlocked: boolean;
  hostedBlockedMessage: string;
  hostedGenericError: boolean;
  hostedGenericErrorMessage: string;
  hostedGuestCardError: boolean;
  hostedGuestCardErrorMessage: string;
  hostedGuestPhoneError: boolean;
  hostedGuestPhoneErrorMessage: string;
  verificationInputsVisible: boolean;
  hostedVerificationInvalidCode: boolean;
  hostedVerificationErrorText: string;
  hostedVerificationResendReady: boolean;
  reviewConsentReady: boolean;
  approveReady: boolean;
  approveButtonText: string;
  hasPasskeyPrompt: boolean;
  bodyTextPreview: string;
  fetchedAt: number;
}

export interface PaypalFlowState {
  snapshot: PaypalStateSnapshot | null;
  lastStep: {
    requestedAt: number;
    completedAt: number;
    payload: RunHostedStepPayload;
    result: RunHostedStepResult | null;
    error: string;
  } | null;
  storedEmail: string;
  storedPassword: string;
  storedPhone: string;
  updatedAt: number;
}

export interface PaypalSettings {
  email: string;
  password: string;
  phone: string;
}

export const PAYPAL_FLOW_STATE_KEY = 'opx.paypal.flow.state';
export const PAYPAL_FLOW_SETTINGS_KEY = 'opx.paypal.flow.settings';

export type PaypalHostedGetStateMessage = {
  type: 'opx:paypal-hosted-get-state';
};

export type PaypalRunHostedStepMessage = {
  type: 'opx:paypal-run-hosted-step';
  payload?: RunHostedStepPayload;
};

export type PaypalSubmitLoginMessage = {
  type: 'opx:paypal-submit-login';
  payload?: RunHostedStepPayload;
};

export type PaypalDismissPromptsMessage = {
  type: 'opx:paypal-dismiss-prompts';
};

export type PaypalClickApproveMessage = {
  type: 'opx:paypal-click-approve';
};

export type PaypalMessage =
  | PaypalHostedGetStateMessage
  | PaypalRunHostedStepMessage
  | PaypalSubmitLoginMessage
  | PaypalDismissPromptsMessage
  | PaypalClickApproveMessage;
