import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Keep the public landing page discoverable while preventing polite
      // crawlers from walking authenticated workspaces or enumerating APIs.
      // Runtime auth, same-origin checks and rate limits remain authoritative.
      disallow: [
        '/api/',
        '/admin/',
        '/profile',
        '/media-history',
        '/tools/',
        '/video',
        '/cover',
        '/storyboard-workbench',
        '/segmenter',
        '/formatter',
        '/extract',
        '/voice-studio',
        '/digital-human',
        '/short-drama',
        '/commerce',
        '/youcai',
        '/_next/',
        '/static/',
      ],
    },
  };
}
