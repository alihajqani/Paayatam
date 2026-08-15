import { describe, expect, it } from 'vitest';
import { AppError, ERROR_MESSAGES_FA, ErrorCode, isAppError } from './errors';

const allCodes = Object.values(ErrorCode);

describe('error catalogue', () => {
  it('has a Persian message for every error code', () => {
    const missing = allCodes.filter((code) => !ERROR_MESSAGES_FA[code]);
    expect(missing).toEqual([]);
  });

  it('has no extra messages for codes that do not exist', () => {
    const orphaned = Object.keys(ERROR_MESSAGES_FA).filter(
      (key) => !allCodes.includes(key as ErrorCode),
    );
    expect(orphaned).toEqual([]);
  });

  it.each(allCodes)('%s has a message containing Persian characters', (code) => {
    // Guards against an English placeholder slipping through into user-facing text.
    expect(ERROR_MESSAGES_FA[code]).toMatch(/[؀-ۿ]/);
  });

  it.each(allCodes)('%s has no untranslated ASCII words left in the message', (code) => {
    // Latin letters would mean a partially translated string. Digits and
    // punctuation are fine — Persian copy legitimately contains neither here.
    expect(ERROR_MESSAGES_FA[code]).not.toMatch(/[A-Za-z]{2,}/);
  });
});

describe('AppError', () => {
  it('maps a code to its Persian message', () => {
    const error = new AppError(ErrorCode.DUPLICATE_REQUEST);
    expect(error.messageFa).toBe(ERROR_MESSAGES_FA.DUPLICATE_REQUEST);
  });

  it('assigns the documented HTTP status', () => {
    expect(new AppError(ErrorCode.DUPLICATE_REQUEST).httpStatus).toBe(409);
    expect(new AppError(ErrorCode.UNAUTHENTICATED).httpStatus).toBe(401);
    expect(new AppError(ErrorCode.FORBIDDEN).httpStatus).toBe(403);
    expect(new AppError(ErrorCode.RATE_LIMITED).httpStatus).toBe(429);
    expect(new AppError(ErrorCode.INTERNAL_ERROR).httpStatus).toBe(500);
  });

  it('defaults to 400 for codes without an explicit status', () => {
    expect(new AppError(ErrorCode.CONTENT_BLOCKED).httpStatus).toBe(400);
  });

  it('serialises to the documented envelope', () => {
    const body = new AppError(ErrorCode.CITY_NOT_AVAILABLE).toBody();
    expect(body).toEqual({
      error: {
        code: 'CITY_NOT_AVAILABLE',
        messageFa: ERROR_MESSAGES_FA.CITY_NOT_AVAILABLE,
      },
    });
  });

  it('includes details only when supplied', () => {
    const withDetails = new AppError(ErrorCode.VALIDATION_FAILED, { field: 'title' });
    expect(withDetails.toBody().error.details).toEqual({ field: 'title' });
    expect(new AppError(ErrorCode.VALIDATION_FAILED).toBody().error).not.toHaveProperty('details');
  });

  it('is recognised by isAppError, and other errors are not', () => {
    expect(isAppError(new AppError(ErrorCode.NOT_FOUND))).toBe(true);
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
