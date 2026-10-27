import { isValidLocalUrl } from '$lib/utils/local-url';

describe('isValidLocalUrl', () => {
  it.each([
    'https://photos.home.example',
    'http://192.168.1.10:2283',
    'https://photos.home.example/immich',
    'http://[fd00::10]:2283/api',
  ])('accepts %s', (value) => {
    expect(isValidLocalUrl(value)).toBe(true);
  });

  it.each([
    '',
    'photos.home.example',
    'ftp://photos.home.example',
    'https://',
    'https://user:secret@photos.home.example',
    'https://photos.home.example/?',
    'https://photos.home.example/?key=value',
    'https://photos.home.example/#',
    'https://photos.home.example/#top',
  ])('rejects %s', (value) => {
    expect(isValidLocalUrl(value)).toBe(false);
  });
});
