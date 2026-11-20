import type { Metadata } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import 'maplibre-gl/dist/maplibre-gl.css';
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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plusJakartaSans.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-[#f4f4f5] font-sans text-zinc-900 antialiased selection:bg-zinc-950 selection:text-white">
        {children}
      </body>
    </html>
  );
}
