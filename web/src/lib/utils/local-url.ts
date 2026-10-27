/**
 * Mirrors the server's validation for `server.localUrls`: an http or https URL with a host,
 * and no credentials, query, or fragment.
 */
export const isValidLocalUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
};
