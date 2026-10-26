// One source of truth for this site. The deploy script reads `slug`; the page shell reads the rest.
window.SITE = {
  slug: 'immich',              // URL: https://a.yash0.in/<slug>/  (lowercase letters, digits, dashes)
  title: 'OpenFrame',          // Shown in the top bar, the footer and the a.yash0.in index
  updated: '2026-10-26',
  // Optional. Replaces the "a.yash0.in / <slug>" crumb and the footer host link, for sites on their own domain.
  crumb: { label: 'Fork of Immich', href: 'https://github.com/immich-app/immich' },
  footer: { label: 'AGPLv3 · built on Immich', href: 'https://github.com/immich-app/immich' },
  nav: [
    {
      group: 'OpenFrame',
      items: [
        { title: 'Overview', href: './' },
        { title: 'Contributing', href: 'contributing.html' },
      ],
    },
    {
      group: 'Reports',
      items: [
        { title: 'Server performance', href: 'performance.html' },
        { title: 'Latest-release CPU comparison', href: 'release-comparison.html' },
        { title: 'HTTP upload comparison', href: 'http-comparison.html' },
        { title: 'Methodology', href: 'methodology.html' },
      ],
    },
  ],
  // Optional buttons in the top bar, e.g. a PR or repo link.
  links: [{ title: 'GitHub', href: 'https://github.com/Ghoststack0/OpenFrame' }],
};
