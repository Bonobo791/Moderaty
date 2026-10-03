import { escapeHtml } from './emailText';
import type { ProtonMailMessage } from './protonMail';

export const WELCOME_TEMPLATE_VERSION = 1;
export interface WelcomeTeam {
	role: 'owner' | 'admin' | 'member';
	channels: { active: boolean; previewUsed: boolean }[];
}
export interface WelcomeContent {
	email: string;
	displayName: string;
	messageId: string;
	appUrl: string;
	teams: WelcomeTeam[];
}

/** Only an operator-configured HTTPS origin can receive the dashboard CTA. */
export function welcomeAppOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Welcome APP_URL must be an HTTPS origin without credentials, path, query or fragment');
	}
	return url.origin;
}

const CONTACT_URL = 'https://moderaty.com/contact';
const PREVIEW_TEXT = 'Your first steps with Moderaty, from connecting a channel to reviewing comments.';
type PreviewChannel = WelcomeTeam['channels'][number];

function connectionStep(teams: WelcomeTeam[], connected: PreviewChannel[]): string {
	if (connected.length > 0) return 'A channel is already connected in one of your teams. Choose that team and open its channel. To connect another channel, use a team where you are an owner or admin; otherwise ask a team owner or admin.';
	if (teams.some(team => team.role === 'owner' || team.role === 'admin')) return 'In a team where you are an owner or admin, connect your YouTube channel using the Google account that manages it. Google sign-in and granting YouTube channel access are separate steps.';
	return 'To get a channel connected, ask a team owner or admin to grant access using the Google account that manages it. Google sign-in and granting YouTube channel access are separate steps.';
}

function previewStep(connected: PreviewChannel[]): string {
	if (connected.length > 0 && connected.every(channel => channel.previewUsed)) return 'The free moderation preview has already been used on your connected channels. Review the preview entries in the audit log and adjust your rules before your next moderation run.';
	if (connected.length === 0 || connected.some(channel => channel.active && !channel.previewUsed)) return 'Try the free moderation dry run on an active connected channel if its allowance is still available: one free attempt per channel. It does not change comments on YouTube or consume comment credits. An attempted run may use the allowance even if it fails.';
	if (connected.some(channel => channel.active)) return 'Your active channels have already used their moderation preview. Any remaining free preview belongs to a paused channel; check its status with your team. Review earlier preview results in the audit log.';
	return 'Your connected channels are paused. Check their status with your team before starting moderation. The audit log keeps the results of any earlier preview.';
}

function welcomeSteps(teams: WelcomeTeam[]): string[] {
	const connected = teams.flatMap(team => team.channels);
	return [
		'Open your dashboard. If you belong to more than one team, use the team switcher to choose the team whose channels you want to work on.',
		connectionStep(teams, connected),
		'Review the channel’s sensitivity and settings, then add moderation rules for the comments you want to handle. If a control is unavailable for your team role, ask a team owner or admin to make the change.',
		previewStep(connected),
		'Inspect the review queue for comments needing a decision, and the audit log for moderation activity and preview results. A preview does not change YouTube comments; review its results before starting live moderation.'
	];
}

function welcomeText(name: string, steps: string[], dashboard: string, login: string): string {
	return [
		`Hi ${name},`, '', 'Welcome to Moderaty!', PREVIEW_TEXT, '',
		...steps.map((step, index) => `${index + 1}. ${step}`), '',
		`Open your dashboard: ${dashboard}`, `Need to sign in? ${login}`, '',
		`Need a hand? Reply to this email or write to contact@moderaty.com. You can also reach us at ${CONTACT_URL}.`,
		'This is a one-time account getting-started email.'
	].join('\n');
}

/** Static markup joined with explicitly escaped text/URL boundaries, never raw HTML interpolation. */
function welcomeHtml(name: string, steps: string[], dashboard: string, login: string): string {
	const list = steps.map(step => ['<li style="margin-bottom:16px">', escapeHtml(step), '</li>'].join('')).join('');
	return [
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f4f5f7;color:#17202a;font-family:Arial,sans-serif;font-size:16px;line-height:1.6"><div style="display:none;max-height:0;overflow:hidden">',
		escapeHtml(PREVIEW_TEXT), '</div><main style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff"><p>Hi ',
		escapeHtml(name), ',</p><h1 style="font-size:26px;line-height:1.3">Welcome to Moderaty!</h1><p>', escapeHtml(PREVIEW_TEXT),
		'</p><ol style="padding-left:24px">', list, '</ol><p><a href="', escapeHtml(dashboard),
		'" style="display:inline-block;background:#245749;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none">Open your dashboard</a></p><p>Need to sign in? <a href="',
		escapeHtml(login), '">Sign in to Moderaty</a></p><p>Need a hand? Reply to this email or write to <a href="mailto:contact@moderaty.com">contact@moderaty.com</a>. You can also reach us at <a href="',
		CONTACT_URL, '">', CONTACT_URL, '</a>.</p><p style="font-size:13px;color:#535d66">This is a one-time account getting-started email.</p></main></body></html>'
	].join('');
}

/** English v1 until a stored user language preference exists; never infer language from identity. */
export function buildWelcomeEmail(input: WelcomeContent): ProtonMailMessage {
	const origin = welcomeAppOrigin(input.appUrl);
	const dashboard = new URL('/dashboard', origin).href;
	const login = new URL('/login', origin).href;
	const name = input.displayName.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) || 'there';
	const steps = welcomeSteps(input.teams);
	return { toEmail: input.email, replyTo: 'contact@moderaty.com', messageId: input.messageId,
		subject: 'Welcome to Moderaty — let’s get your channel ready',
		textPart: welcomeText(name, steps, dashboard, login), htmlPart: welcomeHtml(name, steps, dashboard, login) };
}
