// Labeled feedback corpus (MOD-87): hand-labeled EN + PT comments covering
// every digest category, abuse-wrapped variants, and `none`. Consumed by
// scripts/feedback-eval.mjs (live faithfulness + abuse-leak check) and by
// its deterministic leak gate in feedback-eval.test.mjs.
//
// Labels are deliberately unambiguous: a case whose expected category or
// hasAbuse could honestly go either way does not belong here — borderline
// wording would turn the eval into noise instead of a gate.
//
//   text:     the raw comment (eval input)
//   lang:     'en' | 'pt'
//   expected: { category, hasAbuse } the classifier must return
//   note:     why the case exists (what it proves)

function cases(lang, category, rows) {
	return rows.map(([text, hasAbuse, note]) => ({ text, lang, expected: { category, hasAbuse }, note }));
}

export const FEEDBACK_CORPUS = [
	// ---- English questions ----
	{ text: 'when is the next video coming?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'schedule question' },
	{ text: 'what mic do you use?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'gear question' },
	{ text: 'where did you get that torque wrench?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'tool question' },
	{ text: 'is this safe for aluminum heads?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'process question' },
	{ text: 'yo dumbass what mic is that', lang: 'en', expected: { category: 'question', hasAbuse: true }, note: 'question wrapped in an insult — claim survives, abuse flag set' },
	{ text: 'what the hell is that tool called, idiot', lang: 'en', expected: { category: 'question', hasAbuse: true }, note: 'question + profanity + insult' },

	// ---- English criticism ----
	{ text: 'the middle section dragged, trim the montage', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'pacing criticism' },
	{ text: 'the audio at 3:00 is blown out', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'audio criticism' },
	{ text: 'the lighting washes out the whole bench', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'production criticism' },
	{ text: 'this was boring as shit, the middle drags forever', lang: 'en', expected: { category: 'criticism', hasAbuse: true }, note: 'criticism with profanity — claim is the pacing note' },
	{ text: 'you idiot, your audio is blown at 3:00', lang: 'en', expected: { category: 'criticism', hasAbuse: true }, note: 'criticism wrapped in an insult' },

	// ---- English corrections ----
	{ text: "the torque spec at 4:20 is wrong — it's 25 ft-lb", lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'specific factual correction' },
	{ text: 'premium fuel is not required, the manual says 87 octane', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'correction citing the manual' },
	{ text: 'that bolt is M8, not M10', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'size correction' },
	{ text: 'moron, the plug gap is 0.028 not 0.035', lang: 'en', expected: { category: 'correction', hasAbuse: true }, note: 'correction wrapped in an insult' },
	{ text: 'you stupid fuck, that is a 13mm socket', lang: 'en', expected: { category: 'correction', hasAbuse: true }, note: 'correction wrapped in profanity' },

	// ---- English requests ----
	{ text: 'please do a video on carb tuning', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'topic request' },
	{ text: 'do a part two on the timing chain', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'follow-up request' },
	{ text: 'can you make one about drum brakes?', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'topic request as a question of ability' },
	{ text: 'make a part two you lazy fuck', lang: 'en', expected: { category: 'request', hasAbuse: true }, note: 'request wrapped in profanity' },
	{ text: 'fix your thumbnails, they are trash', lang: 'en', expected: { category: 'request', hasAbuse: true }, note: 'request + mild insult on the artifact' },

	// ---- English none ----
	{ text: 'great video!', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'praise — no feedback' },
	{ text: 'first!', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'chatter' },
	{ text: 'check out my channel for daily uploads', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'self-promotion' },
	{ text: 'f*** you and this garbage channel', lang: 'en', expected: { category: 'none', hasAbuse: true }, note: 'abuse with no extractable claim — dropped entirely' },
	{ text: 'everything in this video is wrong', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'sweeping dismissal with no specifics — criticism at best, keep strict: none' },

	// ---- Portuguese questions ----
	{ text: 'quando sai o próximo vídeo?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt schedule question' },
	{ text: 'que microfone você usa?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt gear question' },
	{ text: 'onde você comprou essa chave de torque?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt tool question' },
	{ text: 'seu burro, que microfone é esse?', lang: 'pt', expected: { category: 'question', hasAbuse: true }, note: 'pt question wrapped in an insult' },

	// ---- Portuguese criticism ----
	{ text: 'o meio do vídeo ficou arrastado', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt pacing criticism' },
	{ text: 'o áudio tá estourando aos 3:00', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt audio criticism' },
	{ text: 'vídeo chato pra caralho, a parte do meio arrasta', lang: 'pt', expected: { category: 'criticism', hasAbuse: true }, note: 'pt criticism with profanity' },
	{ text: 'seu idiota, o áudio tá estourado aos 3:00', lang: 'pt', expected: { category: 'criticism', hasAbuse: true }, note: 'pt criticism wrapped in an insult' },

	// ---- Portuguese corrections ----
	{ text: 'o torque é 25 Nm, não 35', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt figure correction' },
	{ text: 'aquela porca é M8, não M10', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt size correction' },
	{ text: 'seu burro, a folga é 0.028 e não 0.035', lang: 'pt', expected: { category: 'correction', hasAbuse: true }, note: 'pt correction wrapped in an insult' },

	// ---- Portuguese requests ----
	{ text: 'faz um vídeo sobre regulagem de carburador', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt topic request' },
	{ text: 'faz a parte dois sobre corrente de comando', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt follow-up request' },
	{ text: 'faz a parte dois, seu vagabundo', lang: 'pt', expected: { category: 'request', hasAbuse: true }, note: 'pt request wrapped in an insult' },

	// ---- Portuguese none ----
	{ text: 'ótimo vídeo!', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt praise' },
	{ text: 'primeiro!', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt chatter' },
	{ text: 'vai se foder, seu canal é uma merda', lang: 'pt', expected: { category: 'none', hasAbuse: true }, note: 'pt abuse with no extractable claim' },

	// ==== Expansion to ≥100 cases (MOD-87): other niches — cooking, gaming,
	// tech, fitness, history — so the eval is not tuned to one channel type.

	// ---- English questions (expansion) ----
	...cases('en', 'question', [
		['what camera do you film with?', false, 'gear question, filming'],
		['how long did you let the dough rest?', false, 'cooking process question'],
		['which graphics card was that benchmark on?', false, 'tech setup question'],
		['does this recipe work with almond flour?', false, 'substitution question'],
		['what song is playing at the end, you moron', true, 'music question wrapped in an insult']
	]),

	// ---- English criticism (expansion) ----
	...cases('en', 'criticism', [
		['the background music is louder than your voice', false, 'audio mix criticism'],
		['the intro is way too long before you get to the point', false, 'intro pacing criticism'],
		['the text on screen disappears before I can read it', false, 'on-screen text criticism'],
		['the camera keeps losing focus during the close-ups', false, 'focus criticism'],
		['the music is so fucking loud I cannot hear you', true, 'audio mix criticism with profanity'],
		['the jump cuts are shit, impossible to follow the steps', true, 'editing criticism with profanity']
	]),

	// ---- English corrections (expansion) ----
	...cases('en', 'correction', [
		['water boils at 100 °C at sea level, not 90', false, 'science figure correction'],
		['the Battle of Hastings was in 1066, not 1166', false, 'history date correction'],
		['that GPU has 12 GB of VRAM, not 8', false, 'tech spec correction'],
		['the capital of Australia is Canberra, not Sydney', false, 'geography correction'],
		['dumbass, the recipe card says 180 °C, not 280', true, 'temperature correction wrapped in an insult'],
		['wrong again idiot, the patch released in March, not May', true, 'date correction wrapped in an insult']
	]),

	// ---- English requests (expansion) ----
	...cases('en', 'request', [
		['please add subtitles to your videos', false, 'accessibility format request'],
		['can you do a beginner version of this workout?', false, 'follow-up request phrased as ability question'],
		['please put the full recipe in the description', false, 'description content request'],
		['do a review of the new Steam Deck', false, 'topic request, tech'],
		['add timestamps for once, you lazy bastard', true, 'format request wrapped in profanity'],
		['upload more often you useless clown', true, 'schedule request wrapped in insults']
	]),

	// ---- English none (expansion) ----
	...cases('en', 'none', [
		['love this channel so much', false, 'praise'],
		['this made my day 😂', false, 'reaction with emoji'],
		['subscribe to my channel for free giveaways', false, 'spam / self-promotion'],
		['lol', false, 'minimal chatter'],
		['worst video ever', false, 'vague dismissal, clean wording — rubric says none/clean'],
		['you are a pathetic loser', true, 'pure insult, no claim'],
		['shut up and go die', true, 'hostile phrase, no claim'],
		['nobody asked, delete your channel', true, 'person-directed hostility, no claim']
	]),

	// ---- Portuguese questions (expansion) ----
	...cases('pt', 'question', [
		['qual câmera você usa para gravar?', false, 'pt gear question, filming'],
		['quanto tempo a massa precisa descansar?', false, 'pt cooking process question'],
		['essa receita funciona com farinha de amêndoa?', false, 'pt substitution question'],
		['qual placa de vídeo você usou nesse teste?', false, 'pt tech setup question'],
		['que música é essa no final, seu idiota?', true, 'pt music question wrapped in an insult'],
		['porra, qual é o nome dessa ferramenta?', true, 'pt tool question with profanity']
	]),

	// ---- Portuguese criticism (expansion) ----
	...cases('pt', 'criticism', [
		['a música de fundo está mais alta que a sua voz', false, 'pt audio mix criticism'],
		['a introdução é longa demais', false, 'pt intro pacing criticism'],
		['a câmera perde o foco nos closes', false, 'pt focus criticism'],
		['as legendas somem antes de dar para ler', false, 'pt on-screen text criticism'],
		['a música tá alta pra caralho, não dá pra ouvir nada', true, 'pt audio mix criticism with profanity'],
		['seu babaca, a imagem tá toda tremida', true, 'pt stabilization criticism wrapped in an insult']
	]),

	// ---- Portuguese corrections (expansion) ----
	...cases('pt', 'correction', [
		['a água ferve a 100 °C ao nível do mar, não a 90', false, 'pt science figure correction'],
		['a capital da Austrália é Canberra, não Sydney', false, 'pt geography correction'],
		['essa placa tem 12 GB de memória, não 8', false, 'pt tech spec correction'],
		['o Brasil foi descoberto em 1500, não em 1600', false, 'pt history date correction'],
		['seu imbecil, a temperatura do forno é 180 °C, não 280', true, 'pt temperature correction wrapped in an insult'],
		['errado de novo, otário, a atualização saiu em março', true, 'pt date correction wrapped in an insult']
	]),

	// ---- Portuguese requests (expansion) ----
	...cases('pt', 'request', [
		['coloca legenda nos vídeos, por favor', false, 'pt accessibility format request'],
		['faz uma versão para iniciantes desse treino', false, 'pt follow-up request'],
		['coloca a receita completa na descrição', false, 'pt description content request'],
		['faz uma review do novo Steam Deck', false, 'pt topic request, tech'],
		['coloca os timestamps, seu preguiçoso de merda', true, 'pt format request wrapped in profanity'],
		['abaixa essa música, caralho', true, 'pt audio request with profanity']
	]),

	// ---- Portuguese none (expansion) ----
	...cases('pt', 'none', [
		['amo esse canal', false, 'pt praise'],
		['kkkkkk', false, 'pt laughter chatter'],
		['se inscreve no meu canal, sorteio toda semana', false, 'pt spam / self-promotion'],
		['que vídeo incrível, parabéns', false, 'pt praise'],
		['pior vídeo que já vi', false, 'pt vague dismissal, clean wording'],
		['você é um lixo', true, 'pt pure insult, no claim'],
		['cala a boca, ninguém te quer aqui', true, 'pt hostile phrase, no claim'],
		['some daqui, seu verme', true, 'pt person-directed hostility, no claim']
	])
];
