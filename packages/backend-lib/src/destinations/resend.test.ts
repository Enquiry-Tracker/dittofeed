const MAIL_DATA = {
  from: "school@example.com",
  to: ["parent@example.com"],
  subject: "Test",
  html: "<p>Test</p>",
};

const RATE_LIMITED = {
  data: null,
  error: {
    name: "rate_limit_exceeded",
    message: "Too many requests. You can only make 10 requests per second.",
  },
};

const SENT = { data: { id: "message-id" }, error: null };

function mockResend(send: jest.Mock) {
  jest.doMock("resend", () => ({
    Resend: jest.fn().mockImplementation(() => ({ emails: { send } })),
  }));
}

describe("resend", () => {
  beforeEach(() => {
    jest.resetModules();
    // sendMail backs off with real timers between attempts. Auto-advancing fake
    // timers collapse those jittered waits (up to ~3.5s across four attempts)
    // without the test having to know the delays it does not assert on.
    jest.useFakeTimers({ advanceTimers: 1000 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe("sendMail", () => {
    describe("when the provider rate-limits the first attempt", () => {
      it("retries and succeeds without surfacing an error", async () => {
        const send = jest
          .fn()
          .mockResolvedValueOnce(RATE_LIMITED)
          .mockResolvedValueOnce(SENT);
        mockResend(send);

        const { sendMail } = await import("./resend");
        const result = await sendMail({ apiKey: "key", mailData: MAIL_DATA });

        expect(result.isOk()).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
      });
    });

    describe("when the provider keeps rate-limiting", () => {
      // Explicit timeout: this path waits out every backoff, and with full
      // jitter the worst case sits right at jest's 5s default.
      it("gives up after MAX_SEND_ATTEMPTS and returns the provider error", async () => {
        const send = jest.fn().mockResolvedValue(RATE_LIMITED);
        mockResend(send);

        const { sendMail, MAX_SEND_ATTEMPTS } = await import("./resend");
        const result = await sendMail({ apiKey: "key", mailData: MAIL_DATA });

        expect(send).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);
        // The error must still come back as a Result rather than a throw: the
        // caller turns it into a DFMessageFailure event, which is what alerting
        // counts. A throw here would make sustained rate limiting invisible.
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.name).toEqual("rate_limit_exceeded");
        }
      }, 15_000);
    });

    describe("when the error is terminal", () => {
      it("does not retry an invalid API key", async () => {
        const send = jest.fn().mockResolvedValue({
          data: null,
          error: { name: "validation_error", message: "API key is invalid" },
        });
        mockResend(send);

        const { sendMail } = await import("./resend");
        const result = await sendMail({ apiKey: "bad", mailData: MAIL_DATA });

        expect(send).toHaveBeenCalledTimes(1);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.name).toEqual("validation_error");
        }
      });
    });
  });

  describe("isRetryableResendError", () => {
    it("treats a rate limit as retryable", async () => {
      const { isRetryableResendError } = await import("./resend");
      expect(isRetryableResendError("rate_limit_exceeded")).toBe(true);
    });

    it("treats provider-side 500s as terminal, because a retry could duplicate the email", async () => {
      const { isRetryableResendError } = await import("./resend");
      expect(isRetryableResendError("application_error")).toBe(false);
      expect(isRetryableResendError("internal_server_error")).toBe(false);
    });

    it("treats configuration errors as terminal", async () => {
      const { isRetryableResendError } = await import("./resend");
      expect(isRetryableResendError("validation_error")).toBe(false);
      expect(isRetryableResendError("missing_api_key")).toBe(false);
      expect(isRetryableResendError("invalid_from_address")).toBe(false);
    });
  });
});
