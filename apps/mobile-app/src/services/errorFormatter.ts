const RAW_TECHNICAL_PREFIX = /^(TypeError|ReferenceError|RangeError|SyntaxError|Error:\s*HTTP\s+\d+|HTTP\s+\d{3}$)/i;

/**
 * Translates raw JS/network/HTTP errors into concise user-friendly messages while
 * preserving the original error in console warnings for debugging.
 */
export function formatUserError(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error !== undefined && error !== null) {
    console.warn('[LovedOnes]', error);
  }

  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const trimmed = rawMessage.trim();
  const errorName = error instanceof Error ? error.name : '';

  if (
    errorName === 'ZodError' ||
    /invalid invite|invite url|token query parameter|bind invite|\bqr\b/i.test(trimmed) ||
    (/invite|\bqr\b/i.test(fallback) &&
      (error instanceof SyntaxError || /json parse|unexpected token|invalid url/i.test(trimmed)))
  ) {
    return 'Invalid invite code or QR format. Please scan a valid LovedOnes invite.';
  }

  if (
    error instanceof SyntaxError ||
    /json parse|unexpected token|unexpected end of json|syntaxerror/i.test(trimmed)
  ) {
    return 'Received an unexpected response from the server. Verify your server address.';
  }

  if (
    /network request failed|failed to fetch|networkerror|econnrefused|enotfound|etimedout|timed out|socket hang up|unable to reach/i.test(
      trimmed,
    )
  ) {
    return 'Unable to reach the server. Check your internet connection or server URL.';
  }

  if (
    /\bhttp 40[13]\b|\bstatus code 40[13]\b|unauthorized|forbidden|invalid or expired token|session expired/i.test(
      trimmed,
    )
  ) {
    return "Your session expired or you don't have permission for this action.";
  }

  if (/\bhttp 5\d\d\b|internal server error|bad gateway|service unavailable/i.test(trimmed)) {
    return 'The server is temporarily unavailable. Please try again in a moment.';
  }

  if (trimmed.length > 0 && !RAW_TECHNICAL_PREFIX.test(trimmed) && !/\n\s+at\s+/.test(trimmed)) {
    return trimmed;
  }

  return fallback;
}
