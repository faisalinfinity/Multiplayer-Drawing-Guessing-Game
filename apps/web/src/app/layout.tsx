import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'DoodleRoom — A little drawing. A lot of fun.', description: 'A real-time drawing and guessing game for friends.' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
