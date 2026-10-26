import type { Handle } from '@sveltejs/kit';
import Geist from '$lib/assets/fonts/Geist/Geist-Variable.woff2?url';

// only used during the build to replace the variables from app.html
export const handle = (async ({ event, resolve }) => {
  return resolve(event, {
    transformPageChunk: ({ html }) => {
      return html.replace('%app.font%', () => Geist);
    },
  });
}) satisfies Handle;
