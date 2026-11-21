import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MobileViewportSync } from '@/components/MobileViewportSync';
import './globals.css';

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LovedOnes — Private Group Map',
  description:
    'Self-hosted real-time group location sharing, privacy modes, geofenced places, and chat',
  applicationName: 'LovedOnes',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'LovedOnes',
  },
  icons: {
    icon: [
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
      {
        url: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icons/icon-dark-192.png',
        sizes: '192x192',
        type: 'image/png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icons/icon-dark-512.png',
        sizes: '512x512',
        type: 'image/png',
        media: '(prefers-color-scheme: dark)',
      },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plusJakartaSans.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh bg-[#f4f4f5] font-sans text-zinc-900 antialiased selection:bg-zinc-950 selection:text-white">
        <MobileViewportSync />
        {children}
      </body>
    </html>
  );
}
