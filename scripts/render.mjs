import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROFILE = JSON.parse(readFileSync(new URL('../profile/profile.json', import.meta.url), 'utf8'));
const USER = process.env.GH_USER || PROFILE.socialHandles.find((h) => h.platform === 'github')?.handle;
const TOKEN = process.env.GH_TOKEN;
const NAME = PROFILE.personal.name;
const HOST = `${NAME.split(' ')[0].toLowerCase()}@github`;
const asset = (f) => new URL(`../assets/${f}`, import.meta.url);

const THEMES = {
	dark: {
		bg: '#0d1117', frame: '#30363d', rule: '#262c36', muted: '#7d8590', ink: '#e6edf3', art: '#c9d1d9', artWeight: 400,
		heat: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'], green: '#39d353', bar: '#196c2e',
	},
	light: {
		bg: '#ffffff', frame: '#d0d7de', rule: '#e1e5ea', muted: '#59636e', ink: '#1f2328', art: '#1f2328', artWeight: 700,
		heat: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'], green: '#1a7f37', bar: '#8fd9a0',
	},
};
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const DOTS = ['#ff5f56', '#ffbd2e', '#27c93f'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v, dec = false) => (dec ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
const shortDate = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const span = (s) => (s.length ? `${shortDate(s.start)} to ${shortDate(s.end)}` : '');

function istWindow() {
	const d = new Date(Date.now() + 330 * 60_000);
	const today = d.toISOString().slice(0, 10);
	d.setUTCFullYear(d.getUTCFullYear() - 1);
	d.setUTCDate(d.getUTCDate() + 1);
	return { today, from: `${d.toISOString().slice(0, 10)}T00:00:00+05:30`, to: `${today}T23:59:59+05:30` };
}

export async function fetchCalendar() {
	if (!TOKEN) throw new Error('GH_TOKEN is not set');
	const { today, from, to } = istWindow();
	const query = 'query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel weekday}}}}}}';
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-art' },
		body: JSON.stringify({ query, variables: { login: USER, from, to } }),
	});
	const json = await res.json().catch(() => null);
	const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
	if (!res.ok || json?.errors || !cal) throw new Error(`GitHub GraphQL failed (${res.status}): ${JSON.stringify(json?.errors ?? json)}`);
	const weeks = cal.weeks
		.map((w) => w.contributionDays
			.filter((d) => d.date <= today)
			.map((d) => ({ date: d.date, count: d.contributionCount, level: LEVEL[d.contributionLevel], weekday: d.weekday })))
		.filter((w) => w.length);
	return { total: cal.totalContributions, weeks };
}

export function computeStats(weeks, total) {
	const days = weeks.flat();
	if (days.length < 300) throw new Error(`Only ${days.length} days returned, refusing to render`);
	let i = days.length - 1;
	if (days[i].count === 0) i--;
	const end = i;
	while (i >= 0 && days[i].count > 0) i--;
	const current = { length: end - i, start: days[i + 1]?.date, end: days[end]?.date };
	let longest = { length: 0 };
	let run = 0;
	days.forEach((d, j) => {
		run = d.count > 0 ? run + 1 : 0;
		if (run > longest.length) longest = { length: run, start: days[j - run + 1].date, end: d.date };
	});
	const active = days.filter((d) => d.count > 0).length;
	const best = days.reduce((a, d) => (d.count > a.count ? d : a));
	const monthly = new Map();
	for (const d of days) monthly.set(d.date.slice(0, 7), (monthly.get(d.date.slice(0, 7)) ?? 0) + d.count);
	return { total, days: days.length, active, avg: active ? total / active : 0, best, current, longest, monthly: [...monthly] };
}

function heatmapSvg(weeks, total, t) {
	const CELL = 13;
	const STEP = 16;
	const LEFT = 34;
	const TOP = 24;
	const NW = weeks.length;
	const W = LEFT + NW * STEP + 6;
	const H = TOP + 7 * STEP + 22;
	const REVEAL = 3.6;
	const DUR = 0.55;
	const maxorder = NW - 1 + 6 * 0.55;

	const marks = [];
	weeks.forEach((w, wi) => {
		const m = +w[0].date.slice(5, 7) - 1;
		if (marks.at(-1)?.m !== m) marks.push({ m, wi });
	});
	const labels = marks
		.filter((k, i) => !marks[i + 1] || marks[i + 1].wi - k.wi >= 3)
		.map((k) => `<text class="lbl" x="${LEFT + k.wi * STEP}" y="${TOP - 8}">${MONTHS[k.m]}</text>`)
		.concat([['Mon', 1], ['Wed', 3], ['Fri', 5]].map(([d, r]) => `<text class="lbl" x="2" y="${TOP + r * STEP + CELL - 2}">${d}</text>`))
		.join('');

	let rects = '';
	weeks.forEach((w, wk) => {
		for (const d of w) {
			const delay = (((wk + d.weekday * 0.55) / maxorder) * REVEAL).toFixed(3);
			rects += `<rect class="c ${d.level ? 'g' : 'e'}" x="${LEFT + wk * STEP}" y="${TOP + d.weekday * STEP}" width="${CELL}" height="${CELL}" rx="2.5" fill="${t.heat[d.level]}" style="animation-delay:${delay}s"/>`;
		}
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<style>
  text.lbl { fill:${t.muted}; font-size:13px; font-weight:600; }
  text.total { fill:${t.ink}; font-size:15px; font-weight:700; }
  .c { transform-box:fill-box; transform-origin:center; opacity:0; animation:pop ${DUR}s ease-out both; }
  .g { animation:pop ${DUR}s ease-out both, flash ${DUR + 0.15}s ease-out both; }
  @keyframes pop { 0%{opacity:0;transform:scale(.2)} 60%{opacity:1;transform:scale(1.1)} 100%{opacity:1;transform:scale(1)} }
  @keyframes flash { 0%{filter:brightness(2.4)} 45%{filter:brightness(2.4)} 100%{filter:brightness(1)} }
  @media (prefers-reduced-motion: reduce) { .c { opacity:1 !important; animation:none !important; } }
</style>
<rect width="${W}" height="${H}" fill="none"/>
${labels}
${rects}
<text class="total" x="${LEFT}" y="${H - 6}">${fmt(total)} contributions in the last year</text>
</svg>`;
}

function chrome(w, h, t, title) {
	return `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="${t.bg}" stroke="${t.frame}"/>`
		+ `<line x1="0" y1="30" x2="${w}" y2="30" stroke="${t.frame}"/>`
		+ DOTS.map((c, i) => `<circle cx="${20 + i * 16}" cy="15" r="5" fill="${c}"/>`).join('')
		+ `<text x="${w / 2}" y="19" fill="${t.muted}" font-size="12" text-anchor="middle">${esc(title)}</text>`;
}

// Both cards share this canvas so they line up at equal widths in the README table.
const COLS = 180;
const ART_W = 800;
const CELL_W = ART_W / COLS;
const CELL_H = (CELL_W * 15) / 8;
const ROWS = Math.round((COLS * 8) / 15);
const CANVAS_W = ART_W + 40;
const CANVAS_H = Math.round(30 + ROWS * CELL_H + 30 + 20);

function portraitSvg(lines, t) {
	const PAD = 20;
	const top = Math.floor((ROWS - lines.length) / 2);
	const rows = [...Array(Math.max(0, top)).fill(''), ...lines].slice(0, ROWS);
	const artTop = 30 + PAD * 0.35;
	const rowDur = 5.8 / ROWS;
	const fontSize = (CELL_H * 0.86).toFixed(1);

	let art = '';
	rows.forEach((line, ry) => {
		if (!line.trim()) return;
		const y = artTop + ry * CELL_H + CELL_H * 0.74;
		const rowY = artTop + ry * CELL_H;
		const delay = ry * rowDur;
		art += `<clipPath id="r${ry}"><rect x="${PAD}" y="${rowY.toFixed(1)}" height="${CELL_H.toFixed(2)}" width="0">`
			+ `<animate attributeName="width" from="0" to="${ART_W}" begin="${delay.toFixed(3)}s" dur="${rowDur.toFixed(2)}s" fill="freeze"/></rect></clipPath>`
			+ `<g class="row" clip-path="url(#r${ry})"><text xml:space="preserve" x="${PAD}" y="${y.toFixed(1)}" fill="${t.art}" font-size="${fontSize}" font-weight="${t.artWeight}" textLength="${(line.length * CELL_W).toFixed(1)}" lengthAdjust="spacing">${esc(line)}</text></g>`
			+ `<rect class="cur" y="${(rowY + 1).toFixed(1)}" width="${CELL_W.toFixed(2)}" height="${(CELL_H - 2).toFixed(2)}" fill="${t.art}" opacity="0">`
			+ `<animate attributeName="x" from="${PAD}" to="${PAD + ART_W}" begin="${delay.toFixed(3)}s" dur="${rowDur.toFixed(2)}s" fill="freeze"/>`
			+ `<set attributeName="opacity" to="0.85" begin="${delay.toFixed(3)}s"/><set attributeName="opacity" to="0" begin="${(delay + rowDur).toFixed(3)}s"/></rect>`;
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" font-family="${MONO}">`
		+ '<style>@media (prefers-reduced-motion: reduce){.row{clip-path:none!important}.cur{display:none!important}}</style>'
		+ chrome(CANVAS_W, CANVAS_H, t, `${HOST}: ~$ ./portrait.sh`) + art
		+ statusBar(t, `${HOST}:~$ whoami <tspan fill="${t.art}">${NAME}</tspan>`, `${HOST}:~$ whoami ${NAME} `.length) + '</svg>';
}

const STATUS_LINE = 30 + ROWS * CELL_H + 7;
const STATUS_Y = STATUS_LINE + 19;

function statusBar(t, html, chars, right = '') {
	return `<line x1="0" y1="${STATUS_LINE.toFixed(1)}" x2="${CANVAS_W}" y2="${STATUS_LINE.toFixed(1)}" stroke="${t.frame}"/>`
		+ `<text x="20" y="${STATUS_Y.toFixed(1)}" fill="${t.muted}" font-size="13">${html}</text>`
		+ (right ? `<text x="${CANVAS_W - 20}" y="${STATUS_Y.toFixed(1)}" fill="${t.muted}" font-size="13" text-anchor="end">${esc(right)}</text>` : '')
		+ `<rect x="${(20 + chars * 13 * 0.6).toFixed(1)}" y="${(STATUS_Y - 12).toFixed(1)}" width="8" height="14" fill="${t.art}">`
		+ '<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.51;1" dur="1s" repeatCount="indefinite"/></rect>';
}

let clipId = 0;

// Odometer: each digit is a clipped column of 0-9 that CSS rolls up to its final digit.
function odometer(str, x, y, size, fill, delay, spins, anchor = 'start') {
	const adv = size * 0.6;
	const lh = size * 1.25;
	const left = anchor === 'end' ? x - str.length * adv : x;
	const id = `o${++clipId}`;
	let n = 0;
	const cols = [...str].map((ch, i) => {
		const cx = (left + (i + 0.5) * adv).toFixed(1);
		if (!/\d/.test(ch)) return `<text x="${cx}" y="${y}">${ch}</text>`;
		const end = spins * 10 + +ch;
		const stack = Array.from({ length: end + 1 }, (_, k) => `<tspan x="${cx}" y="${(y + k * lh).toFixed(1)}">${k % 10}</tspan>`).join('');
		return `<g class="o" style="transform:translateY(${(-end * lh).toFixed(1)}px);animation-delay:${(delay + n++ * 0.08).toFixed(2)}s"><text>${stack}</text></g>`;
	}).join('');
	return `<clipPath id="${id}"><rect x="${(left - 6).toFixed(1)}" y="${(y - size * 0.9).toFixed(1)}" width="${(str.length * adv + 12).toFixed(1)}" height="${(size * 0.98).toFixed(1)}"/></clipPath>`
		+ `<g clip-path="url(#${id})" fill="${fill}" font-size="${size}" font-weight="700" text-anchor="middle">${cols}</g>`;
}

function statsSvg(s, t) {
	const W = CANVAS_W;
	const H = CANVAS_H;
	const L = 44;
	const R = W - 44;
	const HERO = 136;
	const HERO_Y = 174;
	const LEDGER = HERO_Y + 86;
	const ROW = 50;
	const VAL_X = 452;
	const ROWS_AT = 0.75;
	const ROW_STAGGER = 0.14;
	const PLOT_BOT = STATUS_LINE - 76;
	const BARS_AT = 1.75;
	const BAR_STAGGER = 0.06;
	const BAR_DUR = 1;

	const rule = (y, at) => `<rect class="d" x="${L}" y="${y}" width="${R - L}" height="1" fill="${t.rule}" style="animation-delay:${at.toFixed(2)}s"/>`;
	const fade = (at, body) => `<g class="f" style="animation-delay:${at.toFixed(2)}s">${body}</g>`;
	const parts = [];

	const streak = String(s.current.length);
	parts.push(fade(0.1, odometer(streak, L - 6, HERO_Y, HERO, t.green, 0.2, 2)
		+ `<text x="${(L - 6 + streak.length * HERO * 0.6 + 16).toFixed(1)}" y="${HERO_Y}" fill="${t.muted}" font-size="32">day streak</text>`
		+ `<text x="${L}" y="${HERO_Y + 42}" fill="${t.muted}" font-size="24">${s.current.length ? span(s.current) : 'No active streak'}</text>`));

	const rows = [
		['Longest streak', String(s.longest.length), s.longest.length === 1 ? 'day' : 'days', span(s.longest)],
		['Contributions', fmt(s.total), '', 'in the last year'],
		['Active days', fmt(s.active), '', `${Math.round((s.active / s.days) * 100)}% of the year`],
		['Best day', fmt(s.best.count), '', shortDate(s.best.date)],
		['Daily average', fmt(s.avg, true), '', 'per active day'],
	];
	rows.forEach(([label, value, unit, detail], i) => {
		const y0 = LEDGER + i * ROW;
		const base = y0 + ROW / 2 + 8.5;
		const at = ROWS_AT + i * ROW_STAGGER;
		parts.push(rule(y0, at - 0.1));
		parts.push(fade(at, `<text x="${L}" y="${base}" fill="${t.muted}" font-size="24">${label}</text>`
			+ odometer(value, VAL_X, base, 28, t.ink, at + 0.1, 1, 'end')
			+ (unit ? `<text x="${VAL_X + 12}" y="${base}" fill="${t.muted}" font-size="22">${unit}</text>` : '')
			+ `<text x="${R}" y="${base}" fill="${t.muted}" font-size="22" text-anchor="end">${esc(detail)}</text>`));
	});
	const ledgerEnd = LEDGER + rows.length * ROW;
	parts.push(rule(ledgerEnd, ROWS_AT + rows.length * ROW_STAGGER - 0.1));

	const titleY = ledgerEnd + 58;
	const barMax = PLOT_BOT - titleY - 55;
	parts.push(fade(BARS_AT - 0.25, `<text x="${L}" y="${titleY}" fill="${t.muted}" font-size="24">Contributions by month</text>`));
	const months = s.monthly.slice(-12);
	const peak = Math.max(...months.map(([, v]) => v), 1);
	const slot = (R - L) / months.length;
	const barW = slot * 0.5;
	let bars = '';
	months.forEach(([ym, v], i) => {
		const h = Math.max(3, (barMax * v) / peak);
		const cx = L + (i + 0.5) * slot;
		const at = BARS_AT + i * BAR_STAGGER;
		const top = v === peak;
		bars += `<rect class="b" x="${(cx - barW / 2).toFixed(1)}" y="${(PLOT_BOT - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${(h + 8).toFixed(1)}" rx="5" fill="${top ? t.green : t.bar}" style="animation-delay:${at.toFixed(2)}s"/>`;
		parts.push(fade(at, `<text x="${cx.toFixed(1)}" y="${PLOT_BOT + 32}" fill="${top ? t.ink : t.muted}" font-size="19" text-anchor="middle">${MONTHS[+ym.slice(5) - 1]}</text>`));
		if (top) parts.push(fade(at + BAR_DUR * 0.6, `<text x="${cx.toFixed(1)}" y="${(PLOT_BOT - h - 14).toFixed(1)}" fill="${t.ink}" font-size="21" font-weight="700" text-anchor="middle">${fmt(peak)}</text>`));
	});
	parts.push(`<clipPath id="plot"><rect width="${W}" height="${PLOT_BOT}"/></clipPath><g clip-path="url(#plot)">${bars}</g>`);
	parts.push(rule(PLOT_BOT, BARS_AT - 0.2));

	const now = new Date(Date.now() + 330 * 60_000).toISOString();
	const status = statusBar(t, `${HOST}:~$`, `${HOST}:~$ `.length, `updated ${shortDate(now)}, ${now.slice(11, 16)} IST`);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${MONO}">`
		+ '<style>'
		+ '.f{animation:f .7s cubic-bezier(.2,.8,.2,1) both}@keyframes f{from{opacity:0;transform:translateY(10px)}}'
		+ '.d{transform-box:fill-box;transform-origin:left;animation:d .9s cubic-bezier(.65,0,.35,1) both}@keyframes d{from{transform:scaleX(0)}}'
		+ '.o{animation:o 1.6s cubic-bezier(.2,1.05,.3,1) both}@keyframes o{from{transform:translateY(0)}}'
		+ `.b{transform-box:fill-box;transform-origin:bottom;animation:b ${BAR_DUR}s cubic-bezier(.3,1.25,.45,1) both}@keyframes b{from{transform:scaleY(0)}}`
		+ '@media (prefers-reduced-motion: reduce){.f,.d,.o,.b{animation:none!important}}'
		+ '</style>'
		+ chrome(W, H, t, `${HOST}: ~$ ./stats.sh`) + parts.join('') + status + '</svg>';
}

const svgLogo = (path) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='white' d='${path}'/></svg>`).toString('base64')}`;
const LINKEDIN_LOGO = svgLogo('M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z');
const DB_LOGO = svgLogo('M12 2C7 2 3 3.6 3 5.5v13C3 20.4 7 22 12 22s9-1.6 9-3.5v-13C21 3.6 17 2 12 2zm0 2c4.4 0 7 1.3 7 1.5S16.4 7 12 7 5 5.7 5 5.5 7.6 4 12 4zm7 14.5c0 .2-2.6 1.5-7 1.5s-7-1.3-7-1.5v-2.7c1.6.8 4.2 1.2 7 1.2s5.4-.4 7-1.2v2.7zm0-5c0 .2-2.6 1.5-7 1.5s-7-1.3-7-1.5v-2.7c1.6.8 4.2 1.2 7 1.2s5.4-.4 7-1.2v2.7z');

// skill name in profile.json -> [badge color, simple-icons slug or data URI, logo color]; unknown skills still get a plain badge
const SKILLS = {
	TypeScript: ['3178C6', 'typescript'], JavaScript: ['F7DF1E', 'javascript', 'black'], Java: ['ED8B00', 'openjdk'],
	Python: ['3776AB', 'python'], Go: ['00ADD8', 'go'], 'Node.js': ['339933', 'nodedotjs'], 'React.js': ['20232A', 'react', '61DAFB'],
	React: ['20232A', 'react', '61DAFB'], 'Next.js': ['000000', 'nextdotjs'], 'Vue.js': ['35495E', 'vuedotjs', '4FC08D'],
	NestJS: ['E0234E', 'nestjs'], 'React Native': ['20232A', 'react', '61DAFB'], 'Express.js': ['000000', 'express'],
	Django: ['092E20', 'django'], SQL: ['336791', DB_LOGO], MongoDB: ['47A248', 'mongodb'], PostgreSQL: ['4169E1', 'postgresql'],
	Docker: ['2496ED', 'docker'], Redis: ['DC382D', 'redis'], Electron: ['47848F', 'electron'], GraphQL: ['E10098', 'graphql'],
};
const PLATFORMS = {
	linkedin: ['LinkedIn', '0A66C2', LINKEDIN_LOGO], instagram: ['Instagram', 'E4405F', 'instagram'], x: ['X', '000000', 'x'],
	facebook: ['Facebook', '0866FF', 'facebook'], github: null,
};

const shield = (s) => encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_'));
const badge = (text, color, logo, logoColor = 'white') =>
	`https://img.shields.io/badge/${shield(text)}-${color}?style=for-the-badge${logo ? `&logo=${encodeURIComponent(logo)}&logoColor=${logoColor}` : ''}`;
const host = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');

export function readmeMd(p) {
	const me = p.personal;
	const [current, ...past] = p.experience.filter((e) => !e.hideOnResume);
	const city = me.location.city.split(',')[0];
	const name = me.name;

	const intro = `<p>\n<b>${name}</b> · ${current.title} at <b>${current.company}</b> · ${city}, ${me.location.country}<br>\n`
		+ `${me.about.replace(/\.?$/, '.')}<br>\n`
		+ (past.length ? `Previously at ${list(past.map((e) => e.company))}.\n` : '')
		+ '</p>';

	const skills = p.topSkills.map((s) => {
		const [color, logo, logoColor] = SKILLS[s] ?? ['30363d', ''];
		return `![${s}](${badge(s, color, logo, logoColor)})`;
	});
	const stack = Array.from({ length: Math.ceil(skills.length / 6) }, (_, i) => skills.slice(i * 6, i * 6 + 6).join(' ')).join('<br>\n');

	const npxPkg = me.npx.replace(/^npx\s+/, '');
	const links = [
		[`${name}'s portfolio`, 'Portfolio', '7F51FF', 'googlechrome', `https://${host(me.website)}`],
		[`${name}'s resume`, 'Resume', '0F766E', 'readdotcv', me.resume],
		...p.socialHandles.filter((h) => PLATFORMS[h.platform] !== null).map((h) => {
			const [label, color, logo] = PLATFORMS[h.platform] ?? [h.platform[0].toUpperCase() + h.platform.slice(1), h.color.replace('#', ''), h.platform];
			return [`${name} on ${label}`, label, color, logo, `${h.url}/${h.handle}`];
		}),
		[`${name}'s CLI portfolio: ${me.npx}`, me.npx, 'CB3837', 'npm', `https://www.npmjs.com/package/${npxPkg}`],
		[`Book a call with ${name}`, 'Book a call', '1A73E8', 'googlecalendar', me.meeting],
	].map(([alt, label, color, logo, href]) => `[![${alt}](${badge(label, color, logo)})](${href})`).join(' ');

	const cmd = (c) => `<h3><code>${HOST} ~ $ ${c}</code></h3>`;
	const card = (file, width, alt) => `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="./assets/${file}-dark.svg">\n`
		+ `  <img src="./assets/${file}-light.svg" width="${width}" alt="${alt}">\n</picture>`;

	return `<div align="center">\n\n${cmd('./contributions.sh')}\n\n${card('heatmap', '860', `${name}'s GitHub contribution graph, updated daily`)}\n\n<br>\n<br>\n\n`
		+ `${cmd('whoami')}\n\n${card('portrait', '49%', `ASCII portrait of ${name}, ${current.title}`)}\n`
		+ `${card('stats', '49%', `${name}'s GitHub streak and contribution stats, updated daily`)}\n\n<br>\n<br>\n\n`
		+ `${cmd('cat about.md')}\n\n${intro}\n\n<br>\n\n${stack}\n\n<br>\n\n${cmd('./links.sh')}\n\n${links}\n\n</div>\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { total, weeks } = await fetchCalendar();
	const stats = computeStats(weeks, total);
	const read = (f) => readFileSync(asset(f), 'utf8').replace(/\n+$/, '').split('\n');
	const lines = read('portrait.txt');
	const darkLines = existsSync(asset('portrait-dark.txt')) ? read('portrait-dark.txt') : lines;
	const out = Object.entries(THEMES).flatMap(([name, t]) => [
		[`heatmap-${name}.svg`, heatmapSvg(weeks, total, t)],
		[`portrait-${name}.svg`, portraitSvg(name === 'dark' ? darkLines : lines, t)],
		[`stats-${name}.svg`, statsSvg(stats, t)],
	]);
	for (const [file, svg] of out) writeFileSync(asset(file), svg);
	writeFileSync(new URL('../README.md', import.meta.url), readmeMd(PROFILE).replace(/\s*[\u2012-\u2015\u2212]\s*/g, ', '));
	console.log(`total ${total}, streak ${stats.current.length}/${stats.longest.length}, ${out.map(([f, svg]) => `${f} ${Math.round(svg.length / 1024)}KB`).join(', ')}`);
}
