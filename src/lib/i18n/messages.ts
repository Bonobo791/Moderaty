// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Advanced Digital Marketing LTDA
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import type { Locale } from './locale';

const MESSAGES = {
	en: {
		languageLabel: 'Language',
		english: 'English',
		portuguese: 'Português (Brasil)',
		apply: 'Apply',
		app: 'App',
		dashboard: 'Dashboard',
		usage: 'Usage',
		team: 'Team',
		help: 'Help',
		switchTeam: 'Switch team',
		signOut: 'Sign out',
		maintenance: 'Maintenance',
		moderationPaused: 'Moderation is paused.',
		databaseUnavailable: 'Moderaty is temporarily unable to reach its database — moderation is paused and your settings are safe. The page will work again automatically; nothing is required of you.',
		signInTitle: 'Sign in to Moderaty',
		signInDescription: 'Sign in with your Google account, then connect your YouTube channels to start moderating comments automatically.',
		signInGoogle: 'Sign in with Google',
		finishAccount: 'Finish creating your account',
		almostThere: 'Almost there',
		updatedTerms: 'Updated terms',
		finishAccountPrompt: 'To finish creating your account:',
		legalChanged: 'Our legal documents have changed — please review and accept the current version to continue.',
		createAccount: 'Create account',
		acceptContinue: 'Accept and continue',
		marketingText: 'Send me occasional product updates and moderation tips by e-mail (optional)',
		accountDeletedTitle: 'Your account has been closed',
		accountDeletedBody: 'Your data is now deleted and your account has been closed.',
		accountDeletedBackHome: 'Back to Moderaty'
	},
	'pt-BR': {
		languageLabel: 'Idioma',
		english: 'English',
		portuguese: 'Português (Brasil)',
		apply: 'Aplicar',
		app: 'Aplicativo',
		dashboard: 'Painel',
		usage: 'Uso',
		team: 'Equipe',
		help: 'Ajuda',
		switchTeam: 'Trocar equipe',
		signOut: 'Sair',
		maintenance: 'Manutenção',
		moderationPaused: 'A moderação está pausada.',
		databaseUnavailable: 'O Moderaty não consegue acessar o banco de dados no momento — a moderação está pausada e suas configurações estão seguras. A página voltará a funcionar automaticamente; você não precisa fazer nada.',
		signInTitle: 'Entrar no Moderaty',
		signInDescription: 'Entre com sua conta Google e conecte seus canais do YouTube para começar a moderar comentários automaticamente.',
		signInGoogle: 'Entrar com o Google',
		finishAccount: 'Conclua a criação da sua conta',
		almostThere: 'Quase lá',
		updatedTerms: 'Termos atualizados',
		finishAccountPrompt: 'Para concluir a criação da sua conta:',
		legalChanged: 'Nossos documentos jurídicos foram alterados — revise e aceite a versão atual para continuar.',
		createAccount: 'Criar conta',
		acceptContinue: 'Aceitar e continuar',
		marketingText: 'Quero receber ocasionalmente novidades do produto e dicas de moderação por e-mail (opcional)',
		accountDeletedTitle: 'Sua conta foi encerrada',
		accountDeletedBody: 'Seus dados foram excluídos e sua conta foi encerrada.',
		accountDeletedBackHome: 'Voltar ao Moderaty'
	}
} as const;

export type MessageKey = keyof (typeof MESSAGES)['en'];

export function t(locale: Locale, key: MessageKey): string {
	const value = MESSAGES[locale][key];
	if (!value) throw new Error(`Missing ${locale} translation for ${key}`);
	return value;
}
