import Link from 'next/link';
import { Pencil } from 'lucide-react';

const colors = ['#f6c858', '#ef8580', '#9acfb8', '#a7b8ea', '#ccb1dd', '#eab68d', '#92cbd6', '#eab1ca'];
export function Avatar({ index = 0, name = '', size = 42 }: { index?: number; name?: string; size?: number }) {
  const n = ((index % 8) + 8) % 8;
  return <svg role="img" aria-label={`${name || 'Player'} avatar`} width={size} height={size} viewBox="0 0 64 64" className="avatar">
    <rect x="2" y="2" width="60" height="60" rx={n % 2 ? 23 : 19} fill={colors[n]} />
    {n % 3 === 0 && <path d="M17 14 20 4 28 13M38 13 46 4 48 18" stroke="#25243a" strokeWidth="2.5" fill={colors[n]} />}
    <path d={n % 2 ? 'M17 25q5-7 10 0m11 0q5-7 10 0' : 'M22 25v6m20-6v6'} stroke="#25243a" strokeWidth="3.5" strokeLinecap="round" fill="none" />
    <path d={n % 3 === 1 ? 'M24 39q8 12 16 0Z' : 'M24 39q8 9 16 0'} stroke="#25243a" strokeWidth="2.5" strokeLinecap="round" fill={n % 3 === 1 ? '#fff9ee' : 'none'} />
    <ellipse cx="15" cy="36" rx="4" ry="2" fill="#fff9ee" opacity=".55" /><ellipse cx="49" cy="36" rx="4" ry="2" fill="#fff9ee" opacity=".55" />
  </svg>;
}
export function Brand({ small = false }: { small?: boolean }) {
  return <Link href="/" className={`brand ${small ? 'brand-small' : ''}`} aria-label="DoodleRoom home"><span className="brand-mark"><Pencil size={21} strokeWidth={2.5} /></span><span>doodle<span className="brand-light">room</span><span className="brand-dot">.</span></span></Link>;
}
export function DoodleArt() {
  return <svg viewBox="0 0 600 430" className="hero-art" role="img" aria-label="A hand-drawn orange cat, a rainbow, and playful doodles on a sketchbook">
    <defs><pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#d8d5ca" /></pattern></defs>
    <g transform="rotate(-5 295 215)"><rect x="73" y="44" width="445" height="324" rx="18" fill="#deddd2" /><rect x="65" y="34" width="445" height="324" rx="18" fill="#fff" stroke="#dddcd3" strokeWidth="2" /><rect x="81" y="52" width="413" height="286" fill="url(#dots)" /><path d="M94 34v324" stroke="#eccbc9" strokeWidth="2" />
    <path d="M215 137 206 82 260 122Q300 105 334 123L380 84 373 143Q405 175 385 232Q372 284 297 291Q219 288 204 235Q188 181 215 137Z" fill="#ffcb88" stroke="#323147" strokeWidth="5" strokeLinejoin="round" />
    <path d="M218 104 226 137 246 126M366 108 342 128 366 139" fill="#ef9992" /><path d="M244 178q12-14 24 0M323 178q12-14 24 0" fill="none" stroke="#323147" strokeWidth="5" strokeLinecap="round" /><path d="m283 192 13 13 13-13Z" fill="#323147" /><path d="M296 205q-7 20-21 8m21-8q7 20 21 8" stroke="#323147" strokeWidth="4" fill="none" strokeLinecap="round" /><path d="m213 201-38-8m41 23-40 5m197-20 38-8m-41 23 40 5" stroke="#323147" strokeWidth="4" strokeLinecap="round" />
    <path d="m413 61 7 17 18 1-14 11 4 18-15-10-16 10 5-18-15-11 18-1Z" fill="#f7d65c" stroke="#323147" strokeWidth="2.5" /><path d="M120 295q26-70 55 0" stroke="#ef8580" strokeWidth="10" fill="none" /><path d="M131 295q15-46 34 0" stroke="#e9c759" strokeWidth="8" fill="none" /><path d="M141 295q6-25 15 0" stroke="#9acfb8" strokeWidth="7" fill="none" />
    <text x="269" y="324" fontSize="22" fill="#7a796f" fontFamily="cursive">definitely a cat.</text></g>
    <g transform="rotate(13 466 325)"><rect x="392" y="302" width="173" height="58" rx="14" fill="#25243a" /><text x="410" y="338" fontFamily="sans-serif" fontWeight="700" fontSize="18" fill="#fff">a potato? 👀</text></g>
    <g transform="rotate(-10 106 62)"><rect x="14" y="38" width="147" height="48" rx="13" fill="#9acfb8" stroke="#fff" strokeWidth="4" /><text x="34" y="68" fontFamily="sans-serif" fontWeight="700" fontSize="16" fill="#25243a">you’re drawing!</text></g>
    <path d="m529 152 19-11m-11 32 23 1M39 236l-19 7m27 10-13 17" stroke="#ef8580" strokeWidth="4" strokeLinecap="round" />
    <path d="m462 229 63-100 15 10-64 99-20 11Z" fill="#9acfb8" stroke="#323147" strokeWidth="3" strokeLinejoin="round" /><path d="m462 229 14 9-20 11Z" fill="#f7d5ae" stroke="#323147" strokeWidth="2" />
  </svg>;
}
